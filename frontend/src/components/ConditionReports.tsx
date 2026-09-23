import React, { useState } from 'react';
import { api, ConditionPhase, ConditionReport } from '../api/client';
import { LIMITS } from '../limits';

// What a mini looked like at each end of a loan, so "the spear was already
// bent" is a fact instead of an argument. Both sides file their own, and
// nothing can be edited afterwards — the server refuses a second report for
// the same end from the same person, which is the point of keeping one.
//
// Shut by default: most loans never need this, and a panel that is always open
// turns every handoff into a inspection.

const PHASE_LABELS: Record<ConditionPhase, string> = {
  handoff: 'At the handoff',
  return: 'At the return',
};

const PHASE_OPTIONS: Record<ConditionPhase, string> = {
  handoff: 'The handoff — how it looked when it changed hands',
  return: 'The return — how it looked going back',
};

type ConditionReportsProps = {
  loanId: number;
  reportCount: number;
  openPhases: ConditionPhase[];
  onRecorded: () => void;
};

export default function ConditionReports({ loanId, reportCount, openPhases, onRecorded }: ConditionReportsProps): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const [reports, setReports] = useState<ConditionReport[]>([]);
  const [phase, setPhase] = useState<ConditionPhase>(openPhases[0] ?? 'return');
  const [note, setNote] = useState<string>('');
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  async function load(): Promise<void> {
    try {
      setReports(await api<ConditionReport[]>(`/api/loans/${loanId}/condition`));
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load the condition notes');
    }
  }

  async function expand(): Promise<void> {
    setOpen(true);
    await load();
  }

  async function record(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Multipart, not JSON: a photo is the whole reason this exists.
      const form = new FormData();
      form.append('phase', phase);
      if (note.trim()) form.append('note', note.trim());
      for (const photo of photos) form.append('photos', photo);

      setReports(await api<ConditionReport[]>(`/api/loans/${loanId}/condition`, { method: 'POST', body: form }));
      setNote('');
      setPhotos([]);
      onRecorded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => void expand()}
        style={{ background: 'none', color: '#8a7d6a', padding: 0, fontSize: '12px', textDecoration: 'underline', marginTop: '8px' }}
      >
        {reportCount > 0 ? `Condition notes (${reportCount})` : 'Record how it looks'}
      </button>
    );
  }

  const canSend = Boolean(note.trim()) || photos.length > 0;

  return (
    <div style={{ marginTop: '10px', borderTop: '1px solid #3d3629', paddingTop: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', color: '#c9a84c', fontWeight: 600 }}>Condition notes</span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          style={{ background: 'none', color: '#8a7d6a', padding: 0, fontSize: '12px', textDecoration: 'underline' }}
        >
          Hide
        </button>
      </div>

      {reports.length > 0 ? (
        <ul aria-label="Condition notes" style={{ listStyle: 'none', display: 'grid', gap: '10px', marginBottom: '10px' }}>
          {reports.map(report => (
            <li key={report.id} style={{ background: '#252219', border: '1px solid #3d3629', borderRadius: '6px', padding: '10px' }}>
              <div style={{ fontSize: '12px', color: '#8a7d6a', marginBottom: '4px' }}>
                {PHASE_LABELS[report.phase]} · {report.authorName} · {new Date(report.createdAt).toLocaleDateString()}
              </div>
              {report.note && <p style={{ fontSize: '13px', whiteSpace: 'pre-wrap' }}>{report.note}</p>}
              {report.photos.length > 0 && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                  {report.photos.map(photo => (
                    <img
                      key={photo}
                      src={photo}
                      alt={`${PHASE_LABELS[report.phase]}, by ${report.authorName}`}
                      style={{ width: '72px', height: '72px', objectFit: 'cover', borderRadius: '4px' }}
                    />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '10px' }}>Nothing recorded yet.</p>
      )}

      {openPhases.length > 0 && (
        <form noValidate onSubmit={(e: React.FormEvent) => void record(e)} style={{ display: 'grid', gap: '8px' }}>
          <label htmlFor={`condition-${loanId}-phase`} style={{ fontSize: '13px', color: '#8a7d6a' }}>Which end</label>
          <select
            id={`condition-${loanId}-phase`}
            value={phase}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPhase(e.target.value as ConditionPhase)}
          >
            {openPhases.map(option => (
              <option key={option} value={option}>{PHASE_OPTIONS[option]}</option>
            ))}
          </select>

          <label htmlFor={`condition-${loanId}-note`} style={{ fontSize: '13px', color: '#8a7d6a' }}>Note</label>
          <textarea
            id={`condition-${loanId}-note`}
            rows={3}
            maxLength={LIMITS.conditionNote}
            placeholder="e.g. spear already bent, base scuffed on the left"
            value={note}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
          />

          <label htmlFor={`condition-${loanId}-photos`} style={{ fontSize: '13px', color: '#8a7d6a' }}>
            Photos (up to {LIMITS.conditionPhotos})
          </label>
          <input
            id={`condition-${loanId}-photos`}
            type="file"
            accept="image/*"
            multiple
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setPhotos([...(e.target.files ?? [])].slice(0, LIMITS.conditionPhotos))}
          />

          <button
            type="submit"
            className="btn-secondary"
            disabled={busy || !canSend}
            title={canSend ? undefined : 'Add a note or a photo first'}
            style={{ justifySelf: 'start', padding: '6px 14px', fontSize: '13px' }}
          >
            Record
          </button>
          <p style={{ fontSize: '12px', color: '#8a7d6a' }}>
            Once recorded this can't be changed — that's what makes it worth having.
          </p>
        </form>
      )}

      {error && <div className="error-msg" style={{ marginTop: '8px' }}>{error}</div>}
    </div>
  );
}
