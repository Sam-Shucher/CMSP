import React, { useState } from 'react';
import ImageDropzone from './ImageDropzone';

const MAX_IMAGES = 3;

type MultiImagePickerProps = {
  existingPaths: string[]; // current server-side image paths — empty when adding a new mini
  onChange: (keptExisting: string[], newFiles: File[]) => void;
};

// Lets you keep/remove a mini's existing photos and add new ones, up to
// MAX_IMAGES total. Reuses ImageDropzone as the "add another" affordance.
export default function MultiImagePicker({ existingPaths, onChange }: MultiImagePickerProps): React.ReactElement {
  const [kept, setKept]       = useState<string[]>(existingPaths);
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);

  const total = kept.length + newFiles.length;

  function removeExisting(path: string): void {
    const next = kept.filter(p => p !== path);
    setKept(next);
    onChange(next, newFiles);
  }

  function removeNew(index: number): void {
    const nextFiles = newFiles.filter((_, i) => i !== index);
    const nextPreviews = previews.filter((_, i) => i !== index);
    setNewFiles(nextFiles);
    setPreviews(nextPreviews);
    onChange(kept, nextFiles);
  }

  function addFile(file: File): void {
    const nextFiles = [...newFiles, file];
    setNewFiles(nextFiles);
    setPreviews([...previews, URL.createObjectURL(file)]);
    onChange(kept, nextFiles);
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: total > 0 ? '10px' : 0 }}>
        {kept.map((path: string) => (
          <div key={path} style={thumbWrapStyle}>
            <img src={path} alt="Mini" style={thumbImgStyle} />
            <button type="button" onClick={() => removeExisting(path)} style={removeButtonStyle}>Remove</button>
          </div>
        ))}
        {newFiles.map((file: File, i: number) => (
          <div key={`${file.name}-${i}`} style={thumbWrapStyle}>
            <img src={previews[i]} alt="Preview" style={thumbImgStyle} />
            <button type="button" onClick={() => removeNew(i)} style={removeButtonStyle}>Remove</button>
          </div>
        ))}
      </div>

      {total < MAX_IMAGES ? (
        <ImageDropzone file={null} previewUrl={null} onSelect={addFile} onClear={() => {}} />
      ) : (
        <p style={{ fontSize: '12px', color: '#8a7d6a' }}>{MAX_IMAGES} of {MAX_IMAGES} photos used — remove one to add another.</p>
      )}
    </div>
  );
}

const thumbWrapStyle: React.CSSProperties = {
  position: 'relative',
  width: '96px',
};

const thumbImgStyle: React.CSSProperties = {
  width: '96px',
  height: '96px',
  objectFit: 'cover',
  borderRadius: '6px',
  border: '1px solid #3d3629',
  display: 'block',
};

const removeButtonStyle: React.CSSProperties = {
  marginTop: '4px',
  width: '100%',
  background: 'none',
  border: 'none',
  color: '#c0392b',
  cursor: 'pointer',
  fontSize: '11px',
  padding: 0,
};
