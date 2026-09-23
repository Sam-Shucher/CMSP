import { describe, it, expect } from 'vitest';
import { messages, fitMessage } from './notificationMessages';

describe('notification wording', () => {
  it('reads naturally for the hold line', () => {
    expect(messages.holdPlaced('Alice', 'Dire Wolf', 2)).toBe('Alice placed a hold on Dire Wolf (#2 in line)');
    expect(messages.yourTurn('Dire Wolf')).toBe('It\'s your turn — you can now negotiate for Dire Wolf');
    expect(messages.holdBecameRequest('Alice', 'Dire Wolf')).toBe('Alice\'s hold on Dire Wolf is now a request');
    expect(messages.movedUp('Dire Wolf', 1)).toBe('You moved up to #1 in line for Dire Wolf');
    expect(messages.spotOpened('Dire Wolf')).toBe('A hold spot opened on Dire Wolf');
    expect(messages.miniRemoved('Dire Wolf')).toBe('Dire Wolf was removed by its owner, so your place in line was cleared');
  });

  it('reads naturally for loans', () => {
    expect(messages.requestCreated('Bob', 'Dire Wolf')).toBe('Bob requested Dire Wolf');
    expect(messages.termsProposed('Bob', 'Dire Wolf')).toBe('Bob proposed new terms for Dire Wolf');
    expect(messages.termsApproved('Bob', 'Dire Wolf', false)).toBe('Bob approved the terms for Dire Wolf');
    expect(messages.termsApproved('Bob', 'Dire Wolf', true)).toBe('Bob approved the terms for Dire Wolf — you\'re both agreed');
    expect(messages.termsAppliedToAll('Bob', 1)).toBe('Bob updated the terms on 1 other request with you');
    expect(messages.termsAppliedToAll('Bob', 3)).toBe('Bob updated the terms on 3 other requests with you');
    expect(messages.requestCancelled('Bob', 'Dire Wolf')).toBe('Bob cancelled the request for Dire Wolf');
    expect(messages.requestCancelledByRemoval('Bob', 'Dire Wolf')).toBe('Bob is no longer in the group, so the request for Dire Wolf was cancelled');
    expect(messages.handedOff('Owner', 'Dire Wolf', new Date(2026, 9, 15, 12))).toBe('Owner confirmed the handoff — Dire Wolf is adventuring with you until Oct 15');
    expect(messages.received('Bob', 'Dire Wolf')).toBe('Bob confirmed they got Dire Wolf');
    expect(messages.returned('Owner', 'Dire Wolf')).toBe('Owner marked Dire Wolf as returned');
    expect(messages.lost('Owner', 'Dire Wolf')).toBe('Owner marked Dire Wolf as lost');
    expect(messages.criticallyWounded('Owner', 'Dire Wolf')).toBe('Owner marked Dire Wolf as critically wounded');
    expect(messages.overdue('Dire Wolf')).toBe('Dire Wolf is overdue');
  });

  it('never exceeds the 255-character column, trimming long names with an ellipsis', () => {
    const long = messages.requestCreated('x'.repeat(100), 'y'.repeat(255));

    const fitted = fitMessage(long);

    expect(fitted.length).toBe(255);
    expect(fitted.endsWith('…')).toBe(true);
    expect(fitMessage('short')).toBe('short');
  });
});
