import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

// Form for adding a new mini to the collection.
// Submits as multipart/form-data so an image can be included alongside the text fields.
export default function UploadMiniPage(): React.ReactElement {
  const navigate = useNavigate();

  // Text fields
  const [name, setName]               = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [tags, setTags]               = useState<string>(''); // comma-separated input string

  // Image upload state
  const [image, setImage]     = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null); // object URL for the preview img

  const [error, setError]     = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  // Hidden file input — we trigger it programmatically when the drop zone is clicked
  const fileRef = useRef<HTMLInputElement>(null);

  // When the user picks a file, store it and generate a local preview URL.
  // URL.createObjectURL creates a temporary blob URL that the browser can render immediately.
  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file: File | undefined = e.target.files?.[0];
    if (!file) return;
    setImage(file);
    setPreview(URL.createObjectURL(file));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setError('');
    setLoading(true);

    try {
      // Build a FormData object — this is how you send files and text together in one request.
      // The browser sets the Content-Type to multipart/form-data automatically.
      const fd = new FormData();
      fd.append('name', name.trim());
      if (description.trim()) fd.append('description', description.trim());
      if (tags.trim())        fd.append('tags', tags.trim());
      if (image)              fd.append('image', image);

      // Pass body directly (not json:) so the api() helper doesn't set Content-Type to JSON
      await api('/api/minis', { method: 'POST', body: fd });
      navigate('/'); // back to the dashboard after a successful upload
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  }

  // Removes the selected image and resets the hidden file input value
  function clearImage(): void {
    setImage(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '640px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '24px' }}>Add a Mini</h2>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        {error && <div className="error-msg">{error}</div>}

        {/* Name — required */}
        <div>
          <label style={labelStyle}>Name *</label>
          <input
            type="text"
            value={name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
            placeholder="e.g. Human Paladin, Beholder, Dire Wolf"
            required
            autoFocus
          />
        </div>

        {/* Description — optional free text */}
        <div>
          <label style={labelStyle}>Description</label>
          <textarea
            value={description}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
            placeholder="Scale, manufacturer, paint job notes…"
            rows={3}
            style={{ resize: 'vertical' }}
          />
        </div>

        {/* Tags — user types a comma-separated list; we show a live chip preview */}
        <div>
          <label style={labelStyle}>
            Tags{' '}
            <span style={{ color: '#8a7d6a', textTransform: 'none', fontSize: '11px' }}>
              (comma-separated)
            </span>
          </label>
          <input
            type="text"
            value={tags}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTags(e.target.value)}
            placeholder="undead, boss, dragon, painted"
          />
          {/* Live tag preview — split on commas and render each as a chip */}
          {tags && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: '8px' }}>
              {tags.split(',').map((t: string) => t.trim()).filter(Boolean).map((t: string) => (
                <span key={t} className="tag">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* Image drop zone — clicking it triggers the hidden file input */}
        <div>
          <label style={labelStyle}>Photo</label>
          <div
            onClick={() => fileRef.current?.click()}
            style={{
              border: '2px dashed #3d3629',
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
            onMouseLeave={(e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = '#3d3629')}
          >
            {preview ? (
              // Show the selected image as a preview before uploading
              <img src={preview} alt="Preview" style={{ maxWidth: '100%', maxHeight: '300px', objectFit: 'contain' }} />
            ) : (
              <div style={{ textAlign: 'center', color: '#8a7d6a' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>📷</div>
                <p style={{ fontSize: '13px' }}>Click to choose an image</p>
                <p style={{ fontSize: '12px', marginTop: '4px' }}>JPG, PNG, GIF, WebP — max 10 MB</p>
              </div>
            )}
          </div>

          {/* Hidden file input — only image types accepted */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            style={{ display: 'none' }}
          />

          {/* File info + remove button, shown once an image is selected */}
          {image && (
            <p style={{ fontSize: '12px', color: '#8a7d6a', marginTop: '6px' }}>
              {image.name} ({(image.size / 1024 / 1024).toFixed(1)} MB)
              <button
                type="button"
                onClick={clearImage}
                style={{ marginLeft: '10px', background: 'none', border: 'none', color: '#c0392b', cursor: 'pointer', fontSize: '12px', padding: 0 }}
              >
                Remove
              </button>
            </p>
          )}
        </div>

        {/* Submit / Cancel */}
        <div style={{ display: 'flex', gap: '12px', paddingTop: '4px' }}>
          <button className="btn-primary" type="submit" disabled={loading} style={{ flex: 1, padding: '12px' }}>
            {loading ? 'Uploading…' : 'Add to Collection'}
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate('/')} style={{ padding: '12px 20px' }}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  color: '#8a7d6a',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
