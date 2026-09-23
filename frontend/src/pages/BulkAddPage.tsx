import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import ImageDropzone from '../components/ImageDropzone';
import { photoProblem, ACCEPTED_PHOTO_TYPES } from '../utils/photoFiles';
import { parseTable, draftsFromTable, nameFromFilename, DraftFields } from '../utils/bulkImport';
import { looksBlank, normalizePrice, priceProblem, tagsProblem } from '../utils/validation';
import { LIMITS } from '../limits';
import { useShowPrices } from '../App';

// Adding a whole shelf at once. Adding one mini at a time, three photos each,
// is what stops people finishing — so this takes a pile of photos (one mini
// each, named as you go) or a spreadsheet, lets every row be checked over, and
// then adds them one after another through the same POST /api/minis the
// single form uses. One at a time on purpose: the Pi has one core, and a row
// the server refuses stays here with its reason while the rest still go in.

// Enough for a real shelf; a bigger collection goes in a few batches.
const MAX_ROWS = 100;
const MAX_PHOTOS = LIMITS.photosPerMini;
const SPREADSHEET_TYPES = '.csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain';

type DraftPhoto = { id: number; file: File; preview: string };
type DraftRow = DraftFields & { key: number; photos: DraftPhoto[]; problem: string | null };
type Result = { text: string; added: number };

let nextId = 1;

function newRow(fields: Partial<DraftFields>, photos: DraftPhoto[] = []): DraftRow {
  return { key: nextId++, name: '', description: '', tags: '', price: '', ...fields, photos, problem: null };
}

function toPhoto(file: File): DraftPhoto {
  return { id: nextId++, file, preview: URL.createObjectURL(file) };
}

function forget(photos: DraftPhoto[]): void {
  photos.forEach(photo => URL.revokeObjectURL(photo.preview));
}

function minis(count: number): string {
  return `${count} mini${count === 1 ? '' : 's'}`;
}

// FileReader rather than File.text(): the same thing, but it works everywhere
// this app's tests run too.
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error(`Couldn't read "${file.name}"`));
    reader.readAsText(file);
  });
}

export default function BulkAddPage(): React.ReactElement {
  // A group with prices turned off gets no price field, and a spreadsheet's
  // price column is skipped (and said so) — the server would ignore it anyway.
  const showPrices = useShowPrices();
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [sharedTags, setSharedTags] = useState<string>('');
  const [notices, setNotices] = useState<string[]>([]);
  const [pasting, setPasting] = useState<boolean>(false);
  const [pasted, setPasted] = useState<string>('');
  const [progress, setProgress] = useState<string>('');
  const [result, setResult] = useState<Result | null>(null);
  const saving = progress !== '';

  // Checking photos and reading files take a moment; this always holds the
  // latest rows, so two quick picks in a row can't overwrite each other.
  const rowsRef = useRef<DraftRow[]>(rows);
  function commit(next: DraftRow[]): void {
    rowsRef.current = next;
    setRows(next);
  }

  // Release the photo previews when leaving the page.
  useEffect(() => () => rowsRef.current.forEach(row => forget(row.photos)), []);

  // Twenty named minis is a lot to lose to a stray click on a link.
  const unsaved = rows.length > 0;
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent): void => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  function roomFor(count: number): { fits: number; notice: string | null } {
    const room = MAX_ROWS - rowsRef.current.length;
    if (count <= room) return { fits: count, notice: null };
    return {
      fits: Math.max(0, room),
      notice: `Only ${MAX_ROWS} minis fit in one go, so ${count - Math.max(0, room)} weren't added — add these first, then carry on.`,
    };
  }

  async function addPhotos(files: File[]): Promise<void> {
    setResult(null);
    const checked = await Promise.all(files.map(async file => ({ file, problem: await photoProblem(file) })));
    const usable = checked.filter(c => c.problem === null).map(c => c.file);
    const { fits, notice } = roomFor(usable.length);

    setNotices([...checked.flatMap(c => (c.problem ? [c.problem] : [])), ...(notice ? [notice] : [])]);
    const added = usable.slice(0, fits).map(file => newRow({ name: nameFromFilename(file.name) }, [toPhoto(file)]));
    if (added.length > 0) commit([...rowsRef.current, ...added]);
  }

  function importTable(text: string): boolean {
    setResult(null);
    const { drafts, problems } = draftsFromTable(parseTable(text), { withPrice: showPrices });
    const { fits, notice } = roomFor(drafts.length);
    setNotices([...problems, ...(notice ? [notice] : [])]);
    if (fits > 0) commit([...rowsRef.current, ...drafts.slice(0, fits).map(draft => newRow(draft))]);
    return drafts.length > 0;
  }

  async function importFile(file: File): Promise<void> {
    try {
      importTable(await readText(file));
    } catch (err: unknown) {
      setNotices([err instanceof Error ? err.message : `Couldn't read "${file.name}"`]);
    }
  }

  function importPasted(): void {
    if (importTable(pasted)) {
      setPasted('');
      setPasting(false);
    }
  }

  function addBlankRow(): void {
    setResult(null);
    const { fits, notice } = roomFor(1);
    setNotices(notice ? [notice] : []);
    if (fits > 0) commit([...rowsRef.current, newRow({})]);
  }

  function change(key: number, update: (row: DraftRow) => DraftRow): void {
    // Any edit clears the row's last complaint — it's being dealt with.
    commit(rowsRef.current.map(row => (row.key === key ? { ...update(row), problem: null } : row)));
  }

  function setField(key: number, field: keyof DraftFields, value: string): void {
    change(key, row => {
      const next = { ...row };
      next[field] = value;
      return next;
    });
  }

  async function addPhotosToRow(key: number, files: File[]): Promise<void> {
    const checked = await Promise.all(files.map(async file => ({ file, problem: await photoProblem(file) })));
    const row = rowsRef.current.find(r => r.key === key);
    if (!row) return;
    const usable = checked.filter(c => c.problem === null).map(c => c.file);
    const room = MAX_PHOTOS - row.photos.length;
    const messages = checked.flatMap(c => (c.problem ? [c.problem] : []));
    if (usable.length > room) messages.push(`A mini can have ${MAX_PHOTOS} photos, so ${usable.length - room} weren't added.`);
    setNotices(messages);
    const added = usable.slice(0, Math.max(0, room)).map(toPhoto);
    if (added.length > 0) change(key, r => ({ ...r, photos: [...r.photos, ...added] }));
  }

  function removePhoto(key: number, photoId: number): void {
    change(key, row => {
      forget(row.photos.filter(photo => photo.id === photoId));
      return { ...row, photos: row.photos.filter(photo => photo.id !== photoId) };
    });
  }

  // For a mini photographed from more than one side: its photos join the one
  // above, which keeps its own name unless it hasn't been given one yet.
  function combineWithAbove(index: number): void {
    const current = rowsRef.current;
    const above = current[index - 1];
    const row = current[index];
    const merged: DraftRow = {
      ...above,
      name: looksBlank(above.name) ? row.name : above.name,
      photos: [...above.photos, ...row.photos],
      problem: null,
    };
    commit(current.flatMap((r, i) => (i === index - 1 ? [merged] : i === index ? [] : [r])));
  }

  function removeRow(key: number): void {
    const row = rowsRef.current.find(r => r.key === key);
    if (row) forget(row.photos);
    commit(rowsRef.current.filter(r => r.key !== key));
  }

  function tagsFor(row: DraftRow): string {
    return [row.tags, sharedTags].map(tags => tags.trim()).filter(Boolean).join(', ');
  }

  // The same checks the single form makes, so a whole batch isn't sent off
  // only to come back row by row with things that were knowable up front.
  function problemWith(row: DraftRow): string | null {
    if (looksBlank(row.name)) return 'Give this mini a name.';
    if (row.name.trim().length > LIMITS.miniName) return `Keep the name to ${LIMITS.miniName} characters or fewer.`;
    if (row.description.trim().length > LIMITS.description) {
      return `Keep the description to ${LIMITS.description} characters or fewer.`;
    }
    return (showPrices ? priceProblem(row.price) : null) ?? tagsProblem(tagsFor(row));
  }

  function formFor(row: DraftRow): FormData {
    const form = new FormData();
    form.append('name', row.name.trim());
    if (!looksBlank(row.description)) form.append('description', row.description.trim());
    const tags = tagsFor(row);
    if (tags) form.append('tags', tags);
    const price = showPrices ? normalizePrice(row.price) : '';
    if (price) form.append('price', price);
    row.photos.forEach(photo => form.append('images', photo.file));
    return form;
  }

  async function addAll(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setNotices([]);
    setResult(null);

    const checked = rowsRef.current.map(row => ({ ...row, problem: problemWith(row) }));
    const needLooking = checked.filter(row => row.problem !== null).length;
    if (needLooking > 0) {
      commit(checked);
      setResult({ text: `Nothing added yet — ${needLooking === 1 ? 'one mini below needs' : `${needLooking} minis below need`} a look first.`, added: 0 });
      return;
    }

    const total = checked.length;
    let added = 0;
    for (const [i, row] of checked.entries()) {
      setProgress(`Adding ${i + 1} of ${total}…`);
      try {
        await api('/api/minis', { method: 'POST', body: formFor(row) });
        added += 1;
        forget(row.photos);
        commit(rowsRef.current.filter(r => r.key !== row.key));
      } catch (err: unknown) {
        const problem = err instanceof Error ? err.message : 'Something went wrong';
        commit(rowsRef.current.map(r => (r.key === row.key ? { ...r, problem } : r)));
      }
    }
    setProgress('');

    const left = total - added;
    setResult({
      text: left === 0
        ? `Added ${minis(added)} to the collection.`
        : `Added ${added} of ${total} — ${left === 1 ? 'the one below wasn\'t' : `the ${left} below weren't`} saved. Fix ${left === 1 ? 'it' : 'them'} and try again.`,
      added,
    });
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '8px' }}>Add Several Minis</h2>
      <p style={{ color: '#8a7d6a', fontSize: '14px', marginBottom: '20px' }}>
        Drop a pile of photos — one mini each — and name them as you go. Or bring a spreadsheet: a CSV file, or
        cells copied straight out of one, with a first row naming the columns (<strong>name</strong>, and if you
        like <strong>description</strong>, <strong>tags</strong>{showPrices && <>, <strong>price</strong></>}).{' '}
        <Link to="/upload">Just one? Add a single mini.</Link>
      </p>

      <div style={{ display: 'grid', gap: '14px', marginBottom: '20px' }}>
        <ImageDropzone onFiles={(files: File[]) => void addPhotos(files)} />

        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <label htmlFor="bulk-csv" style={{ fontSize: '13px', color: '#8a7d6a' }}>Choose a CSV file</label>
          <input
            id="bulk-csv"
            type="file"
            accept={SPREADSHEET_TYPES}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
              e.target.value = ''; // so the same file can be picked again after fixing it
            }}
            style={{ fontSize: '13px' }}
          />
          <button type="button" className="btn-secondary" onClick={() => setPasting(open => !open)} style={{ padding: '6px 14px', fontSize: '13px' }}>
            Paste from a spreadsheet
          </button>
          <button type="button" className="btn-secondary" onClick={addBlankRow} style={{ padding: '6px 14px', fontSize: '13px' }}>
            Add one without a photo
          </button>
        </div>

        {pasting && (
          <div style={{ display: 'grid', gap: '8px' }}>
            <label htmlFor="bulk-paste" style={labelStyle}>Spreadsheet rows</label>
            <textarea
              id="bulk-paste"
              rows={6}
              placeholder={showPrices ? 'name\ttags\tprice\nDire Wolf\tundead, boss\t12.50' : 'name\ttags\nDire Wolf\tundead, boss'}
              value={pasted}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasted(e.target.value)}
              style={{ fontFamily: 'monospace', fontSize: '13px' }}
            />
            <button
              type="button"
              className="btn-secondary"
              disabled={looksBlank(pasted)}
              onClick={importPasted}
              style={{ justifySelf: 'start', padding: '6px 14px', fontSize: '13px' }}
            >
              Add these rows
            </button>
          </div>
        )}
      </div>

      {notices.map(notice => (
        <p key={notice} className="error-msg" style={{ marginBottom: '8px' }}>{notice}</p>
      ))}

      {result && (
        <div role="status" className={result.added > 0 && rows.length === 0 ? 'success-msg' : 'error-msg'} style={{ marginBottom: '16px' }}>
          {result.text}
          {result.added > 0 && <>{' '}<Link to="/">See them on Browse</Link></>}
        </div>
      )}

      {rows.length > 0 && (
        <form noValidate onSubmit={(e: React.FormEvent) => void addAll(e)}>
          <fieldset disabled={saving} style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: '14px' }}>
            <div>
              <label htmlFor="bulk-shared-tags" style={labelStyle}>Tags for all of these</label>
              <input
                id="bulk-shared-tags"
                type="text"
                placeholder="e.g. shelf 3, painted"
                value={sharedTags}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSharedTags(e.target.value)}
              />
            </div>

            {rows.map((row, index) => {
              const above = index > 0 ? rows[index - 1] : null;
              const canCombine = above !== null && row.photos.length > 0 && above.photos.length + row.photos.length <= MAX_PHOTOS;
              const id = `bulk-${row.key}`;
              return (
                <section key={row.key} aria-label={`Mini ${index + 1}`} style={rowStyle}>
                  <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'flex-start', width: '96px' }}>
                      {row.photos.map((photo, i) => (
                        <div key={photo.id} style={{ position: 'relative' }}>
                          <img
                            src={photo.preview}
                            alt={`Photo ${i + 1} of ${looksBlank(row.name) ? `mini ${index + 1}` : row.name.trim()}`}
                            style={row.photos.length === 1 ? bigThumbStyle : smallThumbStyle}
                          />
                          <button
                            type="button"
                            aria-label={`Remove photo ${i + 1}`}
                            onClick={() => removePhoto(row.key, photo.id)}
                            style={removePhotoStyle}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {row.photos.length < MAX_PHOTOS && (
                        <AddPhotoButton onFiles={(files: File[]) => void addPhotosToRow(row.key, files)} />
                      )}
                    </div>

                    <div style={{ flex: '1 1 260px', display: 'grid', gap: '8px' }}>
                      <div>
                        <label htmlFor={`${id}-name`} style={labelStyle}>Name *</label>
                        <input
                          id={`${id}-name`}
                          type="text"
                          maxLength={LIMITS.miniName}
                          placeholder="e.g. Dire Wolf"
                          value={row.name}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setField(row.key, 'name', e.target.value)}
                        />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: showPrices ? '1fr 110px' : '1fr', gap: '8px' }}>
                        <div>
                          <label htmlFor={`${id}-tags`} style={labelStyle}>Tags</label>
                          <input
                            id={`${id}-tags`}
                            type="text"
                            placeholder="undead, boss"
                            value={row.tags}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setField(row.key, 'tags', e.target.value)}
                          />
                        </div>
                        {showPrices && (
                          <div>
                            <label htmlFor={`${id}-price`} style={labelStyle}>Price</label>
                            <input
                              id={`${id}-price`}
                              type="text"
                              inputMode="decimal"
                              autoComplete="off"
                              placeholder="0.00"
                              value={row.price}
                              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setField(row.key, 'price', e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                      <div>
                        <label htmlFor={`${id}-description`} style={labelStyle}>Description</label>
                        <textarea
                          id={`${id}-description`}
                          rows={2}
                          maxLength={LIMITS.description}
                          placeholder="Manufacturer, scale, series…"
                          value={row.description}
                          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setField(row.key, 'description', e.target.value)}
                          style={{ resize: 'vertical' }}
                        />
                      </div>
                    </div>
                  </div>

                  {row.problem && <div className="error-msg" style={{ marginTop: '8px' }}>{row.problem}</div>}

                  <div style={{ display: 'flex', gap: '14px', marginTop: '8px' }}>
                    {canCombine && (
                      <button type="button" onClick={() => combineWithAbove(index)} style={linkButtonStyle}>
                        Put the photos with the mini above
                      </button>
                    )}
                    <button type="button" onClick={() => removeRow(row.key)} style={{ ...linkButtonStyle, color: '#c0392b' }}>
                      Remove
                    </button>
                  </div>
                </section>
              );
            })}

            <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn-primary" type="submit" style={{ padding: '12px 20px' }}>
                {saving ? 'Adding…' : `Add ${minis(rows.length)}`}
              </button>
              {saving && <span role="status" style={{ fontSize: '13px', color: '#8a7d6a' }}>{progress}</span>}
            </div>
          </fieldset>
        </form>
      )}
    </div>
  );
}

// "Add a photo" for one row — a button in front of a hidden file input, the
// same trick ImageDropzone uses, so the row can be shot from another side.
function AddPhotoButton({ onFiles }: { onFiles: (files: File[]) => void }): React.ReactElement {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => input.current?.click()} style={addPhotoStyle}>
        + Photo
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_PHOTO_TYPES.join(',')}
        multiple
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          e.target.value = '';
        }}
        style={{ display: 'none' }}
      />
    </>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  color: '#8a7d6a',
  marginBottom: '4px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const rowStyle: React.CSSProperties = {
  background: '#1c1a17', border: '1px solid #3d3629', borderRadius: '8px', padding: '12px',
};

const bigThumbStyle: React.CSSProperties = {
  width: '96px', height: '96px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #3d3629', display: 'block',
};

const smallThumbStyle: React.CSSProperties = { ...bigThumbStyle, width: '45px', height: '45px' };

const removePhotoStyle: React.CSSProperties = {
  position: 'absolute', top: '2px', right: '2px', width: '20px', height: '20px', padding: 0, lineHeight: '18px',
  borderRadius: '50%', border: 'none', background: 'rgba(0, 0, 0, 0.7)', color: '#e8e0d0', cursor: 'pointer', fontSize: '14px',
};

const addPhotoStyle: React.CSSProperties = {
  width: '45px', height: '45px', padding: 0, borderRadius: '6px', border: '1px dashed #3d3629',
  background: 'none', color: '#8a7d6a', cursor: 'pointer', fontSize: '11px',
};

const linkButtonStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#8a7d6a', padding: 0, fontSize: '12px', textDecoration: 'underline', cursor: 'pointer',
};
