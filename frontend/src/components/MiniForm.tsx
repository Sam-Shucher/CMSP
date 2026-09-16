import React, { useState } from 'react';
import ImageDropzone from './ImageDropzone';

export type MiniFormValues = {
  name: string;
  description: string;
  tags: string; // comma-separated input string
  price: string;
};

type MiniFormProps = {
  initialValues: MiniFormValues;
  initialPreviewUrl?: string | null; // existing image, when editing a mini that already has one
  submitLabel: string;
  submittingLabel: string;
  onSubmit: (values: MiniFormValues, image: File | null) => Promise<void>;
  onCancel: () => void;
};

// Shared name/description/tags/price/photo form used by both the "Add Mini"
// and "Edit Mini" pages, so the fields and validation only live in one place.
export default function MiniForm({
  initialValues,
  initialPreviewUrl,
  submitLabel,
  submittingLabel,
  onSubmit,
  onCancel,
}: MiniFormProps): React.ReactElement {
  const [name, setName]               = useState<string>(initialValues.name);
  const [description, setDescription] = useState<string>(initialValues.description);
  const [tags, setTags]               = useState<string>(initialValues.tags);
  const [price, setPrice]             = useState<string>(initialValues.price);

  const [image, setImage]     = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(initialPreviewUrl ?? null);

  const [error, setError]     = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  function handleSelectImage(file: File): void {
    setImage(file);
    setPreview(URL.createObjectURL(file));
  }

  function handleClearImage(): void {
    setImage(null);
    setPreview(null);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (price.trim() && (Number.isNaN(Number(price)) || Number(price) < 0)) {
      setError('Price must be a non-negative number');
      return;
    }
    setError('');
    setLoading(true);

    try {
      await onSubmit({ name: name.trim(), description, tags, price }, image);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {error && <div className="error-msg">{error}</div>}

      {/* Name — required */}
      <div>
        <label style={labelStyle} htmlFor="mini-name">Name *</label>
        <input
          id="mini-name"
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
        <label style={labelStyle} htmlFor="mini-description">Description</label>
        <textarea
          id="mini-description"
          value={description}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(e.target.value)}
          placeholder="Scale, manufacturer, paint job notes…"
          rows={5}
          style={{ resize: 'vertical' }}
        />
      </div>

      {/* Tags — user types a comma-separated list; we show a live chip preview */}
      <div>
        <label style={labelStyle} htmlFor="mini-tags">
          Tags{' '}
          <span style={{ color: '#8a7d6a', textTransform: 'none', fontSize: '11px' }}>
            (comma-separated)
          </span>
        </label>
        <input
          id="mini-tags"
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

      {/* Price — optional, defaults to 0 on the server if left blank */}
      <div>
        <label style={labelStyle} htmlFor="mini-price">
          Price{' '}
          <span style={{ color: '#8a7d6a', textTransform: 'none', fontSize: '11px' }}>
            (optional)
          </span>
        </label>
        <input
          id="mini-price"
          type="number"
          min="0"
          step="0.01"
          value={price}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPrice(e.target.value)}
          placeholder="0.00"
        />
      </div>

      {/* Photo — click to browse or drag an image onto the box */}
      <div>
        <label style={labelStyle}>Photo</label>
        <ImageDropzone
          file={image}
          previewUrl={preview}
          onSelect={handleSelectImage}
          onClear={handleClearImage}
        />
      </div>

      {/* Submit / Cancel */}
      <div style={{ display: 'flex', gap: '12px', paddingTop: '4px' }}>
        <button className="btn-primary" type="submit" disabled={loading} style={{ flex: 1, padding: '12px' }}>
          {loading ? submittingLabel : submitLabel}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} style={{ padding: '12px 20px' }}>
          Cancel
        </button>
      </div>
    </form>
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
