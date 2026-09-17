// Wording for every in-app notification, in one place.

export type NotificationType =
  | 'hold_placed' | 'your_turn' | 'hold_became_request' | 'moved_up' | 'spot_opened' | 'mini_removed'
  | 'request_created' | 'terms_proposed' | 'terms_approved' | 'request_cancelled'
  | 'handed_off' | 'received' | 'returned' | 'overdue';

const MAX_LENGTH = 255; // notifications.message column

export const messages = {
  holdPlaced: (holder: string, mini: string, position: number) => `${holder} placed a hold on ${mini} (#${position} in line)`,
  yourTurn: (mini: string) => `It's your turn — you can now negotiate for ${mini}`,
  holdBecameRequest: (holder: string, mini: string) => `${holder}'s hold on ${mini} is now a request`,
  movedUp: (mini: string, position: number) => `You moved up to #${position} in line for ${mini}`,
  spotOpened: (mini: string) => `A hold spot opened on ${mini}`,
  miniRemoved: (mini: string) => `${mini} was removed by its owner, so your place in line was cleared`,

  requestCreated: (borrower: string, mini: string) => `${borrower} requested ${mini}`,
  termsProposed: (name: string, mini: string) => `${name} proposed new terms for ${mini}`,
  termsApproved: (name: string, mini: string, agreed: boolean) =>
    `${name} approved the terms for ${mini}${agreed ? ' — you\'re both agreed' : ''}`,
  termsAppliedToAll: (name: string, count: number) =>
    `${name} updated the terms on ${count} other request${count === 1 ? '' : 's'} with you`,
  requestCancelled: (name: string, mini: string) => `${name} cancelled the request for ${mini}`,
  requestCancelledByRemoval: (name: string, mini: string) =>
    `${name} is no longer in the group, so the request for ${mini} was cancelled`,
  handedOff: (owner: string, mini: string, dueAt: Date) =>
    `${owner} confirmed the handoff — ${mini} is adventuring with you until ${dueAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
  received: (borrower: string, mini: string) => `${borrower} confirmed they got ${mini}`,
  returned: (owner: string, mini: string) => `${owner} marked ${mini} as returned`,
  overdue: (mini: string) => `${mini} is overdue`,
};

export function fitMessage(message: string): string {
  return message.length <= MAX_LENGTH ? message : `${message.slice(0, MAX_LENGTH - 1)}…`;
}
