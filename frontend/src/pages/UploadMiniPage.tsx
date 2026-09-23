import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import MiniForm, { MiniFormValues } from '../components/MiniForm';

// Pre-filled into the description field for every new mini so contributors
// remember to note these details — they're free to edit or delete the lines.
const DESCRIPTION_TEMPLATE = 'Manufacturer: \nScale: \nSeries: \n';

// Page for adding a new mini to the collection.
export default function UploadMiniPage(): React.ReactElement {
  const navigate = useNavigate();

  async function handleSubmit(values: MiniFormValues, newImages: File[]): Promise<void> {
    // Build a FormData object — this is how you send files and text together in one request.
    // The browser sets the Content-Type to multipart/form-data automatically.
    const fd = new FormData();
    fd.append('name', values.name);
    if (values.description.trim()) fd.append('description', values.description.trim());
    if (values.tags.trim())        fd.append('tags', values.tags.trim());
    if (values.price.trim())       fd.append('price', values.price.trim());
    newImages.forEach((file: File) => fd.append('images', file));

    // Pass body directly (not json:) so the api() helper doesn't set Content-Type to JSON
    await api('/api/minis', { method: 'POST', body: fd });
    navigate('/'); // back to the dashboard after a successful upload
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '640px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '8px' }}>Add a Mini</h2>
      <p style={{ color: '#8a7d6a', fontSize: '14px', marginBottom: '24px' }}>
        Adding a whole shelf? <Link to="/upload/bulk">Add several at once</Link> — from a pile of photos or a spreadsheet.
      </p>
      <MiniForm
        initialValues={{ name: '', description: DESCRIPTION_TEMPLATE, tags: '', price: '' }}
        submitLabel="Add to Collection"
        submittingLabel="Uploading…"
        onSubmit={handleSubmit}
        onCancel={() => navigate('/')}
      />
    </div>
  );
}
