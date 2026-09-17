import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MiniStatusBadge from './MiniStatusBadge';

describe('MiniStatusBadge', () => {
  it.each([
    ['available', 'Available'],
    ['requested', 'Requested'],
    ['adventuring', 'Adventuring'],
    ['on_quest', 'On a Quest'],
  ] as const)('labels %s as "%s" with its matching style', (status, label) => {
    render(<MiniStatusBadge status={status} />);

    const badge = screen.getByText(label);
    expect(badge).toHaveClass(`badge-${status}`);
  });
});
