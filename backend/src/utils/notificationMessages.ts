// Wording for every in-app notification, in one place.
import { readableDay } from './bookingRules';

export type NotificationType =
  | 'hold_placed' | 'your_turn' | 'hold_became_request' | 'moved_up' | 'spot_opened' | 'mini_removed'
  | 'request_created' | 'terms_proposed' | 'terms_approved' | 'request_cancelled'
  | 'handed_off' | 'received' | 'returned' | 'overdue' | 'extended' | 'ownership_transferred'
  | 'lost' | 'critically_wounded' | 'condition_recorded' | 'loan_message'
  | 'booking_placed' | 'booking_cancelled' | 'booking_started' | 'booking_became_request' | 'booking_missed';

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
  extended: (name: string, mini: string, days: number, dueAt: Date) =>
    `${name} kept ${mini} for ${days} more day${days === 1 ? '' : 's'} — now due ${dueAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
  ownershipTransferred: (fromName: string, mini: string) => `${fromName} transferred ${mini} to you`,
  lost: (owner: string, mini: string) => `${owner} marked ${mini} as lost`,
  criticallyWounded: (owner: string, mini: string) => `${owner} marked ${mini} as critically wounded`,
  conditionRecorded: (name: string, mini: string, phase: 'handoff' | 'return') =>
    `${name} recorded how ${mini} looked at the ${phase}`,
  // Line breaks and runs of spaces collapse — the bell is one line per entry.
  // A long message is cut to fit the column by fitMessage, like any other.
  loanMessage: (name: string, mini: string, body: string) =>
    `${name} about ${mini}: “${body.replace(/\s+/g, ' ').trim()}”`,

  bookingPlaced: (booker: string, mini: string, startsOn: string) =>
    `${booker} booked ${mini} for ${readableDay(startsOn)}`,
  bookingCancelled: (name: string, mini: string, startsOn: string) =>
    `${name} cancelled the booking on ${mini} for ${readableDay(startsOn)}`,
  bookingStarted: (mini: string) => `Your booking starts today — you can now negotiate for ${mini}`,
  bookingBecameRequest: (booker: string, mini: string) => `${booker}'s booking on ${mini} is now a request`,
  bookingMissed: (mini: string, startsOn: string) =>
    `${mini} never came free for your booking on ${readableDay(startsOn)}`,
};

export function fitMessage(message: string): string {
  return message.length <= MAX_LENGTH ? message : `${message.slice(0, MAX_LENGTH - 1)}…`;
}
