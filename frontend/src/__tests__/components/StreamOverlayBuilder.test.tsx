/**
 * Tests for the streaming-overlay URL builder (#1422).
 *
 * The builder's whole output is a URL, so that is what these assert: the field
 * order, what is omitted at its default, and that the preview does not open a
 * camera stream until it is asked to.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { StreamOverlayBuilder } from '../../components/StreamOverlayBuilder';

const printers = [
  { id: 1, name: 'X1 Carbon', ip_address: '192.168.1.100', serial_number: '00M09A350100001', model: 'X1C' },
  { id: 2, name: 'P1S', ip_address: '192.168.1.101', serial_number: '01P00A000000002', model: 'P1S' },
];

// The URL is rendered inside a <code>, so read it back the way a user would.
function shownUrl(): string {
  const code = document.querySelector('code');
  return code?.textContent ?? '';
}

describe('StreamOverlayBuilder', () => {
  beforeEach(() => {
    server.use(http.get('/api/v1/printers', () => HttpResponse.json(printers)), http.get('/api/v1/settings/overlay-logo', () => new HttpResponse(null, { status: 404 })));
  });

  it('starts on the first printer with the overlay defaults', async () => {
    render(<StreamOverlayBuilder />);

    await waitFor(() => {
      expect(shownUrl()).toContain('/overlay/1');
    });
    // The same set parseConfig() defaults to, so the builder's starting point
    // and a bare /overlay/1 render the same overlay. Emitted in the overlay's
    // own top-to-bottom field order rather than parseConfig's listing order —
    // ?show= is read with includes(), so order is free to be the stable one.
    expect(shownUrl()).toContain('show=filename%2Cstatus%2Cprogress%2Clayers%2Ceta');
    // Defaults are omitted rather than spelled out — a shorter URL to paste.
    expect(shownUrl()).not.toContain('size=');
    expect(shownUrl()).not.toContain('fps=');
    expect(shownUrl()).not.toContain('camera=');
    expect(shownUrl()).not.toContain('token=');
  });

  it('keeps the model opt-in and updates the URL and preview when toggled', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    const model = await screen.findByLabelText('Printer model');
    expect(model).not.toBeChecked();
    const originalUrl = shownUrl();
    await user.click(model);
    expect(new URL(shownUrl()).searchParams.get('show')).toBe('model,filename,status,progress,layers,eta');
    await user.click(screen.getByLabelText('Printer name'));
    expect(new URL(shownUrl()).searchParams.get('show')).toBe('printer,model,filename,status,progress,layers,eta');
    await user.click(screen.getByRole('button', { name: 'Show preview' }));
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', shownUrl()));

    await user.click(model);
    await user.click(screen.getByLabelText('Printer name'));
    expect(shownUrl()).toBe(originalUrl);
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', originalUrl));
  });

  it('opts into artwork in the URL and preview and restores the original URL', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);
    const artwork = await screen.findByLabelText('Artwork');
    expect(artwork).toHaveValue('1');
    const original = shownUrl();
    expect(new URL(original).searchParams.has('artwork')).toBe(false);
    await user.selectOptions(artwork, 'Version 2');
    expect(new URL(shownUrl()).searchParams.get('artwork')).toBe('2');
    await user.click(screen.getByRole('button', { name: 'Show preview' }));
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', shownUrl()));
    await user.selectOptions(artwork, 'Classic');
    expect(shownUrl()).toBe(original);
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', original));
  });

  it('only offers background transparency for Version 2 and preserves its selection', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);
    const artwork = await screen.findByLabelText('Artwork');
    expect(screen.queryByRole('slider', { name: /Background transparency/ })).not.toBeInTheDocument();
    await user.selectOptions(artwork, 'Version 2');
    const slider = screen.getByRole('slider', { name: /Background transparency/ });
    expect(slider).toHaveValue('0');
    expect(shownUrl()).not.toContain('backgroundTransparency');
    fireEvent.change(slider, { target: { value: '65' } });
    expect(new URL(shownUrl()).searchParams.get('backgroundTransparency')).toBe('65');
    await user.click(screen.getByRole('button', { name: 'Show preview' }));
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', shownUrl()));
    await user.selectOptions(artwork, 'Classic');
    expect(screen.queryByRole('slider', { name: /Background transparency/ })).not.toBeInTheDocument();
    expect(shownUrl()).not.toContain('backgroundTransparency');
    await user.selectOptions(artwork, 'Version 2');
    expect(screen.getByRole('slider', { name: /Background transparency/ })).toHaveValue('65');
  });

  it('switches printer', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    await waitFor(() => expect(screen.getByLabelText('Printer')).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Printer'), '2');

    await waitFor(() => expect(shownUrl()).toContain('/overlay/2'));
  });

  it('adds a temperature field the URL did not have', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    await waitFor(() => expect(screen.getByLabelText('Nozzle')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Nozzle'));

    await waitFor(() =>
      expect(shownUrl()).toContain('show=filename%2Cstatus%2Cprogress%2Clayers%2Ceta%2Cnozzle'),
    );
  });

  it('emits fields in the overlay order, not the order they were clicked', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    // "Printer name" is first in the overlay's own top-to-bottom order, so
    // ticking it last must still put it at the front. Otherwise the same
    // selection would produce a different URL depending on click order, and a
    // scene file would stop being comparable to the one next to it.
    await waitFor(() => expect(screen.getByLabelText('Printer name')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Printer name'));

    await waitFor(() => expect(shownUrl()).toContain('show=printer%2Cfilename'));
  });

  it('drops a field when its box is cleared', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    await waitFor(() => expect(screen.getByLabelText('Layer count')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Layer count'));

    await waitFor(() => expect(shownUrl()).not.toContain('layers'));
    expect(shownUrl()).toContain('progress');
  });

  it('emits camera=false when the camera feed is switched off', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    await waitFor(() => expect(screen.getByLabelText('Camera feed')).toBeInTheDocument());
    await user.click(screen.getByLabelText('Camera feed'));

    await waitFor(() => expect(shownUrl()).toContain('camera=false'));
  });

  it('emits size and fps only when they differ from the defaults', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    await waitFor(() => expect(screen.getByLabelText('Text size')).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Text size'), 'large');
    await waitFor(() => expect(shownUrl()).toContain('size=large'));

    await user.selectOptions(screen.getByLabelText('Text size'), 'medium');
    await waitFor(() => expect(shownUrl()).not.toContain('size='));
  });

  it('appends a token and warns that the URL is now a key', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    await waitFor(() => expect(screen.getByLabelText(/token/i)).toBeInTheDocument());
    expect(screen.queryByText(/This URL contains a token/)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/token/i), 'bblt_abc');

    await waitFor(() => expect(shownUrl()).toContain('token=bblt_abc'));
    expect(screen.getByText(/This URL contains a token/)).toBeInTheDocument();
  });

  it('opens no camera stream until the preview is asked for', async () => {
    const user = userEvent.setup();
    render(<StreamOverlayBuilder />);

    await waitFor(() => expect(screen.getByText('Show preview')).toBeInTheDocument());
    // An always-on preview would hold a subscriber on the printer's single
    // camera connection for as long as the settings tab stays open.
    expect(document.querySelector('iframe')).toBeNull();

    await user.click(screen.getByText('Show preview'));

    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain('/overlay/1');
  });

  it('still builds a URL when the printer list cannot be loaded', async () => {
    server.use(http.get('/api/v1/printers', () => HttpResponse.json({ detail: 'nope' }, { status: 500 })));
    render(<StreamOverlayBuilder />);

    // Falls back to printer 1 rather than rendering /overlay/null — the number
    // is the one thing the user can fix by hand in the URL.
    await waitFor(() => expect(shownUrl()).toContain('/overlay/1'));
  });
});

it('adds validated gradient colours to the URL and resets to the default', async () => {
    render(<StreamOverlayBuilder />);
    const from = await screen.findByLabelText('From colour (hex)');
    fireEvent.change(from, { target: { value: '#ff0000' } });
    fireEvent.change(screen.getByLabelText('To colour (hex)'), { target: { value: '#0000ff' } });
    expect(new URL(shownUrl()).searchParams.get('progressFrom')).toBe('#ff0000');
    expect(new URL(shownUrl()).searchParams.get('progressTo')).toBe('#0000ff');
    fireEvent.change(from, { target: { value: 'invalid' } });
    expect(new URL(shownUrl()).searchParams.get('progressFrom')).toBe('#ff0000');
    fireEvent.click(screen.getByRole('button', { name: 'Reset colours' }));
    expect(shownUrl()).not.toContain('progressFrom');
    expect(shownUrl()).not.toContain('progressTo');
  });

it('uploads a logo, includes it in the URL, and removes it from the preview', async () => {
  const user = userEvent.setup();
  let saved = false;
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logo-preview');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  server.use(
    http.get('/api/v1/printers', () => HttpResponse.json(printers)),
    http.get('/api/v1/settings/overlay-logo', () => saved ? new HttpResponse(new Blob(['png'], { type: 'image/png' })) : new HttpResponse(null, { status: 404 })),
    http.post('/api/v1/settings/overlay-logo', () => { saved = true; return HttpResponse.json({ status: 'ok' }); }),
    http.delete('/api/v1/settings/overlay-logo', () => { saved = false; return HttpResponse.json({ status: 'ok' }); }),
  );
  try {
    render(<StreamOverlayBuilder />);
    await user.upload(await screen.findByLabelText('Upload logo'), new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByRole('img', { name: 'Custom logo' })).toHaveAttribute('src', 'blob:logo-preview');
    expect(new URL(shownUrl()).searchParams.get('logo')).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Show preview' }));
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', shownUrl()));
    const previousPreview = screen.getByTitle('Overlay preview');
    const previousUrl = shownUrl();
    await user.upload(screen.getByLabelText('Upload logo'), new File(['new png'], 'replacement.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).not.toBe(previousPreview));
    expect(shownUrl()).toBe(previousUrl);
    expect(await screen.findByRole('img', { name: 'Custom logo' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Custom logo' })).not.toBeInTheDocument());
    expect(new URL(shownUrl()).searchParams.has('logo')).toBe(false);
    await waitFor(() => expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', shownUrl()));
  } finally {
    create.mockRestore();
    revoke.mockRestore();
  }
});

it('debounces continuous preview changes and cancels a pending reload when hidden', async () => {
  server.use(
    http.get('/api/v1/printers', () => HttpResponse.json(printers)),
    http.get('/api/v1/settings/overlay-logo', () => new HttpResponse(null, { status: 404 })),
  );
  render(<StreamOverlayBuilder />);
  await screen.findByRole('option', { name: 'X1 Carbon' });
  fireEvent.change(screen.getByLabelText('Artwork'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
  const original = screen.getByTitle('Overlay preview');
  vi.useFakeTimers();
  try {
    fireEvent.change(screen.getByLabelText('From colour'), { target: { value: '#ff0000' } });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.change(screen.getByRole('slider', { name: /Background transparency/ }), { target: { value: '65' } });
    act(() => vi.advanceTimersByTime(299));
    expect(screen.getByTitle('Overlay preview')).toBe(original);
    expect(original).not.toHaveAttribute('src', shownUrl());
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByTitle('Overlay preview')).not.toBe(original);
    expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', shownUrl());

    fireEvent.change(screen.getByLabelText('From colour'), { target: { value: '#0000ff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.queryByTitle('Overlay preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }));
    expect(screen.getByTitle('Overlay preview')).toHaveAttribute('src', shownUrl());
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  [400, { detail: 'Logo must be a static PNG or WebP image' }, 'Logo must be a static PNG or WebP image'],
  [413, { detail: { message: 'Logo must be at most 2 MiB' } }, 'Logo must be at most 2 MiB'],
  [502, null, 'HTTP 502'],
])('shows the server upload error for status %s', async (status, body, message) => {
  server.use(
    http.get('/api/v1/printers', () => HttpResponse.json(printers)),
    http.get('/api/v1/settings/overlay-logo', () => new HttpResponse(null, { status: 404 })),
    http.post('/api/v1/settings/overlay-logo', () => body ? HttpResponse.json(body, { status }) : new HttpResponse('Bad gateway', { status })),
  );
  const user = userEvent.setup();
  render(<StreamOverlayBuilder />);
  await user.upload(screen.getByLabelText('Upload logo'), new File(['invalid'], 'logo.png', { type: 'image/png' }));
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(new URL(shownUrl()).searchParams.has('logo')).toBe(false);
  expect(screen.getByLabelText('Upload logo')).toBeEnabled();
});
