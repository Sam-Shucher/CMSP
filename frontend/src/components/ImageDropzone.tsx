import React, { useRef, useState } from 'react';

type ImageDropzoneProps = {
  file: File | null;
  previewUrl: string | null;
  onSelect: (file: File) => void;
  onClear: () => void;
};

// Reusable photo picker: click to open the file browser, or drag an image
// straight onto the box. Shared by the "Add Mini" and "Edit Mini" forms.
export default function ImageDropzone({ file, previewUrl, onSelect, onClear }: ImageDropzoneProps): React.ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dropError, setDropError] = useState<string>('');
  const [dragActive, setDragActive] = useState<boolean>(false);

  function isImage(f: File): boolean {
    return /^image\//.test(f.type);
  }

  function handleFiles(fileList: FileList | null): void {
    const picked = fileList?.[0];
    if (!picked) return;

    if (!isImage(picked)) {
      setDropError('Only image files are allowed (jpg, png, gif, webp)');
      return;
    }
    setDropError('');
    onSelect(picked);
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
        {previewUrl ? (
          <img src={previewUrl} alt="Preview" style={{ maxWidth: '100%', maxHeight: '300px', objectFit: 'contain' }} />
        ) : (
          <div style={{ textAlign: 'center', color: '#8a7d6a', padding: '0 16px' }}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>📷</div>
            <p style={{ fontSize: '13px' }}>
              Click here to upload from your file system, or just drag the picture here
            </p>
            <p style={{ fontSize: '12px', marginTop: '4px' }}>JPG, PNG, GIF, WebP — max 10 MB</p>
          </div>
        )}
      </div>

      {/* Hidden file input — only image types accepted */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        data-testid="image-input"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleFiles(e.target.files)}
        style={{ display: 'none' }}
      />

      {dropError && <p className="error-msg" style={{ marginTop: '6px' }}>{dropError}</p>}

      {/* File info + remove button, shown once an image is selected */}
      {file && (
        <p style={{ fontSize: '12px', color: '#8a7d6a', marginTop: '6px' }}>
          {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
          <button
            type="button"
            onClick={onClear}
            style={{ marginLeft: '10px', background: 'none', border: 'none', color: '#c0392b', cursor: 'pointer', fontSize: '12px', padding: 0 }}
          >
            Remove
          </button>
        </p>
      )}
    </div>
  );
}
