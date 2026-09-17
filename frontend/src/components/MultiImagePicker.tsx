import React, { useEffect, useRef, useState } from 'react';
import ImageDropzone from './ImageDropzone';
import { photoProblem } from '../utils/photoFiles';

const MAX_IMAGES = 3;

type MultiImagePickerProps = {
  existingPaths: string[]; // current server-side image paths — empty when adding a new mini
  onChange: (keptExisting: string[], newFiles: File[]) => void;
};

type NewPhoto = { id: number; file: File; preview: string };

let nextPhotoId = 1;

// Lets you keep/remove a mini's existing photos and add new ones, up to
// MAX_IMAGES total. Each picked photo is checked first (type, size, that it
// really opens) so problems are explained before anything is uploaded.
export default function MultiImagePicker({ existingPaths, onChange }: MultiImagePickerProps): React.ReactElement {
  const [kept, setKept]         = useState<string[]>(existingPaths);
  const [added, setAdded]       = useState<NewPhoto[]>([]);
  const [problems, setProblems] = useState<string[]>([]);

  // Checking photos takes a moment; these always hold the latest selection,
  // so two quick picks in a row can't overwrite each other.
  const keptRef = useRef(kept);
  const addedRef = useRef(added);

  const total = kept.length + added.length;

  function update(nextKept: string[], nextAdded: NewPhoto[]): void {
    keptRef.current = nextKept;
    addedRef.current = nextAdded;
    setKept(nextKept);
    setAdded(nextAdded);
    onChange(nextKept, nextAdded.map(p => p.file));
  }

  // Release the preview images when leaving the page.
  useEffect(() => () => addedRef.current.forEach(p => URL.revokeObjectURL(p.preview)), []);

  function removeExisting(path: string): void {
    update(keptRef.current.filter(p => p !== path), addedRef.current);
  }

  function removeNew(index: number): void {
    const photo = addedRef.current[index];
    if (photo) URL.revokeObjectURL(photo.preview);
    update(keptRef.current, addedRef.current.filter((_, i) => i !== index));
  }

  async function addFiles(files: File[]): Promise<void> {
    const checked = await Promise.all(files.map(async file => ({ file, problem: await photoProblem(file) })));

    const messages: string[] = [];
    const accepted: NewPhoto[] = [];
    for (const { file, problem } of checked) {
      if (problem) {
        messages.push(problem);
      } else if (keptRef.current.length + addedRef.current.length + accepted.length >= MAX_IMAGES) {
        messages.push(`Only ${MAX_IMAGES} photos fit — "${file.name}" wasn't added.`);
      } else {
        accepted.push({ id: nextPhotoId++, file, preview: URL.createObjectURL(file) });
      }
    }

    setProblems(messages);
    if (accepted.length > 0) update(keptRef.current, [...addedRef.current, ...accepted]);
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
        {added.map((photo: NewPhoto, i: number) => (
          <div key={photo.id} style={thumbWrapStyle}>
            <img src={photo.preview} alt="Preview" style={thumbImgStyle} />
            <button type="button" onClick={() => removeNew(i)} style={removeButtonStyle}>Remove</button>
          </div>
        ))}
      </div>

      {total < MAX_IMAGES ? (
        <ImageDropzone onFiles={(files: File[]) => void addFiles(files)} />
      ) : (
        <p style={{ fontSize: '12px', color: '#8a7d6a' }}>{MAX_IMAGES} of {MAX_IMAGES} photos used — remove one to add another.</p>
      )}

      {problems.map((message: string) => (
        <p key={message} className="error-msg" style={{ marginTop: '6px' }}>{message}</p>
      ))}
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
