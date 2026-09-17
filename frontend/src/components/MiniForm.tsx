import React, { useState } from 'react';
import MultiImagePicker from './MultiImagePicker';
import FieldError from './FieldError';
import { useValidatedForm } from '../hooks/useValidatedForm';

// Same limits the server enforces (backend/src/utils/inputs.ts and the price
// column) — checked here too so people see the problem before uploading.
const MAX_NAME_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;
const MAX_PRICE = 9999.99;

export type MiniFormValues = {
  name: string;
  description: string;
  tags: string; // comma-separated input string
  price: string;
};

type MiniFormProps = {
  initialValues: MiniFormValues;
  initialImages?: string[]; // existing photos, when editing a mini that already has some
  submitLabel: string;
  submittingLabel: string;
  onSubmit: (values: MiniFormValues, newImages: File[], keptExistingImages: string[]) => Promise<void>;
  onCancel: () => void;
};

// Shared name/description/tags/price/photos form used by both the "Add Mini"
// and "Edit Mini" pages, so the fields and validation only live in one place.
export default function MiniForm({
  initialValues,
  initialImages,
  submitLabel,
  submittingLabel,
  onSubmit,
  onCancel,
}: MiniFormProps): React.ReactElement {
  // Problems are pointed out under each field after a pause, on leaving the
  // field, or on save — never mid-keystroke (see useValidatedForm).
  const form = useValidatedForm<MiniFormValues>(initialValues, {
    name: value => (value.trim() ? null : 'Give your mini a name.'),
    price: value => {
      if (!value.trim()) return null;
      const amount = Number(value);
      if (Number.isNaN(amount)) return 'Enter a price like 12.50, or leave it blank.';
      if (amount < 0) return 'Price can\'t be negative.';
      if (amount > MAX_PRICE) return `Price must be ${MAX_PRICE} or less.`;
      return null;
    },
    tags: value => {
      const tagNames = new Set(value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
      if (tagNames.size > MAX_TAGS) return `Use ${MAX_TAGS} tags or fewer.`;
      if ([...tagNames].some(t => t.length > MAX_TAG_LENGTH)) return `Keep each tag to ${MAX_TAG_LENGTH} characters or fewer.`;
      return null;
    },
  });
  const { name, description, tags, price } = form.values;

  const [keptImages, setKeptImages] = useState<string[]>(initialImages ?? []);
  const [newImages, setNewImages]   = useState<File[]>([]);

  // Problems reported by the server when saving (e.g. not your mini).
  const [error, setError]     = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  function handleImagesChange(kept: string[], added: File[]): void {
    setKeptImages(kept);
    setNewImages(added);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    if (!form.validateAll()) return;
    setLoading(true);

    try {
      await onSubmit({ name: name.trim(), description, tags, price }, newImages, keptImages);
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
          {...form.field('name', 'mini-name')}
          type="text"
          placeholder="e.g. Human Paladin, Beholder, Dire Wolf"
          maxLength={MAX_NAME_LENGTH}
          required
          autoFocus
        />
        <FieldError id="mini-name" message={form.errorFor('name')} />
      </div>

      {/* Description — optional free text */}
      <div>
        <label style={labelStyle} htmlFor="mini-description">Description</label>
        <textarea
          {...form.field('description', 'mini-description')}
          placeholder="Scale, manufacturer, paint job notes…"
          rows={5}
          maxLength={MAX_DESCRIPTION_LENGTH}
          spellCheck
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
          {...form.field('tags', 'mini-tags')}
          type="text"
          placeholder="undead, boss, dragon, painted"
          spellCheck
        />
        <FieldError id="mini-tags" message={form.errorFor('tags')} />
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
          {...form.field('price', 'mini-price')}
          type="number"
          min="0"
          max={MAX_PRICE}
          step="0.01"
          placeholder="0.00"
        />
        <FieldError id="mini-price" message={form.errorFor('price')} />
      </div>

      {/* Photos — up to 3, click to browse or drag onto the box */}
      <div>
        <label style={labelStyle}>Photos</label>
        <MultiImagePicker existingPaths={initialImages ?? []} onChange={handleImagesChange} />
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
