import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalApp } from '../../src/App';

afterEach(cleanup);

describe('LocalApp compact file controls', () => {
  it('groups secondary actions, dismisses them with Escape, and keeps file errors live', async () => {
    const user = userEvent.setup();
    const { container } = render(<LocalApp demoHref="/frog_label/" />);
    const menu = screen.getByRole('button', { name: 'Files' });

    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    const resume = screen.getByRole('button', { name: 'Resume annotations' });
    expect(resume).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeDisabled();

    resume.focus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(menu).toHaveAttribute('aria-expanded', 'false'));
    expect(menu).toHaveFocus();

    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="audio/wav"]',
    );
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute('hidden');
    fireEvent.change(input!, {
      target: { files: [new File(['not audio'], 'not-audio.txt', { type: 'text/plain' })] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a WAV or MP3 file.');
  });
});
