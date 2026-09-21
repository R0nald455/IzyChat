import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';

/**
 * Reporte de consumo del agente hacia IzyTesting.
 *
 * IzyChat ya cobra cada corrida contra el saldo del usuario (transacciones en
 * Mongo). Esto manda el mismo consumo a IzyTesting, que lo acumula en su tabla
 * de logs como `agent_usage` — una fila por usuario y por día — para que el
 * reporte de consumo viva junto al resto del consumo de IA del producto.
 *
 * El envío es best-effort y nunca bloquea ni hace fallar una respuesta: si el
 * backend no responde, se registra el error y la conversación sigue. La fuente
 * de verdad del saldo sigue siendo la colección `Transaction` de IzyChat.
 */

/** Identidad de la persona que consumió, resuelta desde el id de LibreChat. */
export interface IzyUsageIdentity {
  email?: string | null;
}

export interface IzyUsageReporterDeps {
  /** Normalmente `getUserById` de `~/models`. */
  getUserById: (id: string, fieldsToSelect?: string) => Promise<IzyUsageIdentity | null>;
}

export interface AgentUsageReport {
  /** Id del usuario en LibreChat. */
  user: string;
  inputTokens: number;
  outputTokens: number;
  /** Costo exacto en tokenCredits (USD × 1e6), tal como se cobró al saldo. */
  credits?: number;
  model?: string;
  conversationId?: string;
}

interface IzyUsageConfig {
  url: string;
  key: string;
  timeoutMs: number;
}

const EMAIL_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const INGEST_KEY_HEADER = 'X-Izy-Usage-Key';

const emailCache = new Map<string, { email: string; expiresAt: number }>();

/**
 * Huella comparable de un secreto, para diagnosticar sin filtrarlo. IzyTesting
 * calcula la MISMA huella del secreto que recibe, así que dos huellas distintas
 * en los logs de ambos lados dicen "no es el mismo secreto" sin que ninguno de
 * los dos lo escriba.
 */
function keyFingerprint(value: string): string {
  if (!value) {
    return 'vacio';
  }
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
  return `len=${value.length} sha256=${digest}`;
}

let deps: IzyUsageReporterDeps | null = null;
let warnedMissingConfig = false;

/**
 * Habilita el reporte. Se llama una vez al arrancar el servidor; sin esto (o
 * sin las variables de entorno) `reportAgentUsage` es un no-op.
 *
 * Deja constancia en el log de si el espejo quedó activo: un espejo apagado por
 * configuración es indistinguible de uno roto si no se anuncia al arrancar.
 */
export function configureIzyUsageReporter(reporterDeps: IzyUsageReporterDeps): void {
  deps = reporterDeps;
  const config = getConfig();
  if (!config) {
    logger.warn(
      '[izy/usage] Espejo de consumo INACTIVO: faltan IZYTESTING_USAGE_URL y/o IZYTESTING_USAGE_KEY. ' +
        'El saldo se sigue cobrando, pero no se registra `agent_usage` en IzyTesting.',
    );
    return;
  }
  logger.info(
    `[izy/usage] Espejo de consumo activo hacia ${config.url} | cabecera ${INGEST_KEY_HEADER} ` +
      `clave(${keyFingerprint(config.key)}) | timeout ${config.timeoutMs}ms`,
  );
}

/** Solo para pruebas: olvida las dependencias y la caché de emails. */
export function resetIzyUsageReporter(): void {
  deps = null;
  warnedMissingConfig = false;
  emailCache.clear();
}

function getConfig(): IzyUsageConfig | null {
  const url = (process.env.IZYTESTING_USAGE_URL ?? '').trim();
  const key = (process.env.IZYTESTING_USAGE_KEY ?? '').trim();
  if (!url || !key) {
    return null;
  }
  const parsedTimeout = Number(process.env.IZYTESTING_USAGE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  return { url, key, timeoutMs };
}

async function resolveEmail(userId: string): Promise<string | null> {
  const cached = emailCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.email;
  }

  const user = await deps?.getUserById(userId, 'email');
  const email = user?.email?.trim();
  if (!email) {
    return null;
  }

  emailCache.set(userId, { email, expiresAt: Date.now() + EMAIL_CACHE_TTL_MS });
  return email;
}

async function postUsage(config: IzyUsageConfig, body: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    logger.debug(
      `[izy/usage] POST ${config.url} | ${INGEST_KEY_HEADER} clave(${keyFingerprint(config.key)})`,
      body,
    );
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INGEST_KEY_HEADER]: config.key,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      /** El cuerpo trae el motivo (clave mal, usuario desconocido, payload
       *  invalido); sin el, un 403 y un 404 se ven igual en el log. */
      const detail = await response.text().catch(() => '');
      logger.warn(
        `[izy/usage] IzyTesting rechazó el reporte (${response.status} ${response.statusText}) ` +
          `url=${config.url} clave(${keyFingerprint(config.key)}) respuesta=${detail}`,
      );
      if (response.status === 403) {
        logger.warn(
          '[izy/usage] Un 403 significa que la clave que LLEGÓ a IzyTesting no coincide con su ' +
            'AGENT_USAGE_INGEST_KEY, o que no llegó la cabecera. Compará la huella de arriba con ' +
            'la que loguea IzyTesting: si coinciden, el backend tiene otra clave (o no la tiene y ' +
            'falla cerrado); si no coinciden o dice "vacio", un proxy intermedio filtró la cabecera.',
        );
      }
      return;
    }
    logger.debug(`[izy/usage] Consumo reportado OK (${response.status})`, body);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Manda una corrida del agente a IzyTesting. No espera nada de vuelta: se
 * resuelve de inmediato y el envío corre por detrás.
 */
export function reportAgentUsage(report: AgentUsageReport): void {
  const config = getConfig();
  if (!config || !deps) {
    if (!warnedMissingConfig) {
      warnedMissingConfig = true;
      logger.warn(
        '[izy/usage] Hubo consumo de agente pero el espejo está inactivo ' +
          `(config: ${config != null}, deps: ${deps != null}). No se registrará \`agent_usage\`.`,
      );
    }
    return;
  }
  if (!report.user) {
    logger.warn('[izy/usage] Consumo sin usuario; no se reporta');
    return;
  }

  const inputTokens = Math.max(Math.round(report.inputTokens || 0), 0);
  const outputTokens = Math.max(Math.round(report.outputTokens || 0), 0);
  if (inputTokens === 0 && outputTokens === 0) {
    logger.debug(`[izy/usage] Corrida sin tokens (user ${report.user}); no se reporta`);
    return;
  }

  void (async () => {
    try {
      const email = await resolveEmail(report.user);
      if (!email) {
        logger.warn(`[izy/usage] Sin email para el usuario ${report.user}; no se reporta consumo`);
        return;
      }
      await postUsage(config, {
        email,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(report.credits != null ? { credits: Math.max(Math.round(report.credits), 0) } : {}),
        ...(report.model ? { model: report.model } : {}),
        ...(report.conversationId ? { conversation_id: report.conversationId } : {}),
      });
    } catch (error) {
      /** Un fallo de red (DNS, timeout, conexion rechazada) nunca llega a
       *  IzyTesting, asi que este log es el UNICO rastro: sin la url, un
       *  contenedor que no alcanza al backend se confunde con un 403. */
      logger.error(
        `[izy/usage] No se pudo reportar el consumo a ${config.url} ` +
          '(fallo de red o timeout; el saldo SI se cobro). Verifica que el contenedor de ' +
          'LibreChat alcance esa url.',
        error,
      );
    }
  })();
}
