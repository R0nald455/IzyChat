import React, { forwardRef } from 'react';

type FileUploadProps = {
  accept?: string;
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
  handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

const FileUpload: React.ForwardRefExoticComponent<
  FileUploadProps & React.RefAttributes<HTMLInputElement>
> = forwardRef<HTMLInputElement, FileUploadProps>(({ accept, children, handleFileChange }, ref) => {
  return (
    <>
      {children}
      <input
        ref={ref}
        multiple
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </>
  );
});

FileUpload.displayName = 'FileUpload';

export default FileUpload;
