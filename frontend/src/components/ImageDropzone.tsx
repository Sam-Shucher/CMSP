import React, { useRef, useState } from 'react';
import { ACCEPTED_PHOTO_TYPES } from '../utils/photoFiles';

type ImageDropzoneProps = {
  onFiles: (files: File[]) => void;
};

// Photo picker box: click to open the file browser, or drag photos straight
// onto it. Several at once is fine — MultiImagePicker decides what fits.
export default function ImageDropzone({ onFiles }: ImageDropzoneProps): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);

  function handleFiles(fileList: FileList | null): void {
    const files = Array.from(fileList ?? []);
    if (files.length > 0) onFiles(files);
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragActive(false);
    handleFiles(e.dataTransfer.files);
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        data-testid="image-dropzone"
        onClick={() => fileRef.current?.click()}
        onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={(e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        style={{
          border: `2px dashed ${dragActive ? '#c9a84c' : '#3d3629'}`,
          borderRadius: '8px',
          cursor: 'pointer',
          minHeight: '160px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          background: '#1c1a17',
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={(e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = '#c9a84c')}
        onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => { if (!dragActive) e.currentTarget.style.borderColor = '#3d3629'; }}
      >
        <div style={{ textAlign: 'center', color: '#8a7d6a', padding: '0 16px' }}>
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>📷</div>
          <p style={{ fontSize: '13px' }}>
            Click here to upload from your file system, or just drag the pictures here
          </p>
          <p style={{ fontSize: '12px', marginTop: '4px' }}>JPG, PNG, GIF, WebP — max 10 MB each</p>
        </div>
      </div>

      {/* Hidden file input. Cleared after each pick so the same photo can be picked again. */}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_PHOTO_TYPES.join(',')}
        multiple
        data-testid="image-input"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
        style={{ display: 'none' }}
      />
    </div>
  );
}
