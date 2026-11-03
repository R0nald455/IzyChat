require('dotenv').config();
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';
const mongoose = require('mongoose');
const connect = require('./connect');

const dryRun = process.argv.includes('--dry-run');
const BATCH = 200;

function izyTestingBaseUrl() {
  const url = (process.env.IZYTESTING_URL ?? '').trim();
  return url ? url.replace(/\/$/, '') : '';
}

async function mapEmailsToOrganizations(emails) {
  const base = izyTestingBaseUrl();
  const secret = (process.env.IZYCHAT_SERVICE_SECRET ?? '').trim();
  if (!base || !secret) {
    throw new Error('IZYTESTING_URL and IZYCHAT_SERVICE_SECRET are required for backfill');
  }
  const organizations = {};
  for (let i = 0; i < emails.length; i += BATCH) {
    const chunk = emails.slice(i, i + BATCH);
    const response = await fetch(`${base}/usuario/internal/active-organizations/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IzyTesting-Service-Secret': secret,
      },
      body: JSON.stringify({ emails: chunk }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `IzyTesting lookup failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      );
    }
    const body = await response.json();
    Object.assign(organizations, body.organizations ?? {});
  }
  return organizations;
}

(async () => {
  try {
    await connect();
    const Conversation = mongoose.connection.collection('conversations');
    const MemoryEntry = mongoose.connection.collection('memoryentries');
    const ChatProject = mongoose.connection.collection('chatprojects');
    const User = mongoose.connection.collection('users');
    const missingOrg = {
      $or: [
        { organizationId: { $exists: false } },
        { organizationId: null },
        { organizationId: '' },
      ],
    };

    const userIds = [
      ...new Set([
        ...(await Conversation.distinct('user', missingOrg)),
        ...(await ChatProject.distinct('user', missingOrg)),
      ]),
    ];
    console.log(`Documents without organizationId for ${userIds.length} user(s)`);

    const users = await User.find({
      _id: {
        $in: userIds
          .map((id) => new mongoose.Types.ObjectId(id))
          .filter((id) => mongoose.Types.ObjectId.isValid(id)),
      },
    })
      .project({ email: 1 })
      .toArray();

    const emailByUserId = new Map();
    for (const user of users) {
      if (user.email) {
        emailByUserId.set(String(user._id), String(user.email).toLowerCase());
      }
    }
    /** Some conversation.user values are already string ids that match _id. */
    const leftover = userIds.filter((id) => !emailByUserId.has(String(id)));
    if (leftover.length) {
      const extra = await User.find({
        $or: leftover.map((id) => ({ _id: id })),
      })
        .project({ email: 1 })
        .toArray();
      for (const user of extra) {
        if (user.email) {
          emailByUserId.set(String(user._id), String(user.email).toLowerCase());
        }
      }
    }

    const emails = [...new Set([...emailByUserId.values()])];
    const organizations = await mapEmailsToOrganizations(emails);
    let updatedConvos = 0;
    let updatedMemories = 0;
    let updatedProjects = 0;
    let skippedUsers = 0;
    let ambiguousProjects = 0;

    async function organizationForProject(project, fallbackOrganizationId) {
      const projectId = String(project._id);
      const counts = await Conversation.aggregate([
        {
          $match: {
            user: project.user,
            chatProjectId: projectId,
            organizationId: { $type: 'string', $ne: '' },
          },
        },
        { $group: { _id: '$organizationId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray();
      if (counts.length > 1) {
        ambiguousProjects += 1;
      }
      if (counts[0]?._id) {
        return counts[0]._id;
      }
      return fallbackOrganizationId;
    }

    for (const [userId, email] of emailByUserId.entries()) {
      const organizationId = organizations[email];
      if (!organizationId) {
        skippedUsers += 1;
        continue;
      }
      if (dryRun) {
        const count = await Conversation.countDocuments({
          user: userId,
          ...missingOrg,
        });
        updatedConvos += count;
        const projectCount = await ChatProject.countDocuments({
          user: userId,
          ...missingOrg,
        });
        updatedProjects += projectCount;
        continue;
      }
      const convoResult = await Conversation.updateMany(
        {
          user: userId,
          ...missingOrg,
        },
        { $set: { organizationId } },
      );
      updatedConvos += convoResult.modifiedCount ?? 0;
      const memoryResult = await MemoryEntry.updateMany(
        {
          userId: new mongoose.Types.ObjectId(userId),
          ...missingOrg,
        },
        { $set: { organizationId } },
      );
      updatedMemories += memoryResult.modifiedCount ?? 0;

      const projects = await ChatProject.find({ user: userId, ...missingOrg })
        .project({ _id: 1, user: 1 })
        .toArray();
      for (const project of projects) {
        const projectOrg = await organizationForProject(project, organizationId);
        if (!projectOrg) {
          continue;
        }
        const result = await ChatProject.updateOne(
          { _id: project._id, ...missingOrg },
          { $set: { organizationId: projectOrg } },
        );
        updatedProjects += result.modifiedCount ?? 0;
      }
    }

    console.log(
      `${dryRun ? 'Dry run' : 'Backfill'} complete. convos=${updatedConvos} memories=${updatedMemories} projects=${updatedProjects} skippedUsers=${skippedUsers} ambiguousProjects=${ambiguousProjects}`,
    );
    process.exitCode = 0;
  } catch (error) {
    console.error('Izy organization backfill failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
