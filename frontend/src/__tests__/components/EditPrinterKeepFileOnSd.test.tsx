/**
 * Bambuddy deletes the uploaded job file from a printer's SD card once a print
 * finishes. A printer can opt out (#3009), so the print can be restarted from
 * the printer's own screen. The Edit dialog has to show the stored choice and
 * send changes to it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrintersPage } from '../../pages/PrintersPage';
import { setAuthToken } from '../../api/client';

const basePrinter = {
  id: 1,
  name: 'Workshop A1',
  ip_address: '192.168.1.100',
  serial_number: '00M09A350100001',
  model: 'A1 Mini',
  location: null,
  is_active: true,
  auto_archive: true,
  keep_file_on_sd: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const LABEL = 'Keep job file on the SD card after a print';

let patched: Record<string, unknown> | null;

function serve(printer: typeof basePrinter) {
  server.use(
    http.get('*/api/v1/auth/status', () => HttpResponse.json({ auth_enabled: true, requires_setup: false })),
    http.get('*/api/v1/auth/me', () =>
      HttpResponse.json({ id: 1, username: 'boss', is_admin: true, groups: [], permissions: ['printers:update', 'printers:read'] })
    ),
    http.get('/api/v1/printers/', () => HttpResponse.json([printer])),
    http.get('/api/v1/printers/:id/status', () =>
      HttpResponse.json({
        connected: true,
        state: 'IDLE',
        progress: 0,
        layer_num: 0,
        total_layers: 0,
        temperatures: { nozzle: 25, bed: 25, chamber: 25 },
        remaining_time: 0,
        filename: null,
        wifi_signal: -50,
        vt_tray: [],
      })
    ),
    http.get('/api/v1/queue/', () => HttpResponse.json([])),
    http.get('/api/v1/groups/', () => HttpResponse.json([])),
    http.post('/api/v1/printers/diagnostic', () =>
      HttpResponse.json({ printer_id: null, ip_address: '192.168.1.100', overall: 'ok', checks: [] })
    ),
    http.patch('/api/v1/printers/:id', async ({ request }) => {
      patched = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...printer, ...patched });
    })
  );
}

beforeEach(() => {
  patched = null;
  setAuthToken('test-token', 'session');
});

afterEach(() => {
  setAuthToken(null);
});

async function openEditModal() {
  render(<PrintersPage />);
  await waitFor(() => expect(screen.getByText('Workshop A1')).toBeInTheDocument());
  const menuBtn = [...document.querySelectorAll('button')].find((b) => b.querySelector('.lucide-ellipsis-vertical'))!;
  await userEvent.click(menuBtn);
  await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
  await screen.findByText('Edit Printer');
}

describe('EditPrinterModal keep file on SD card', () => {
  it('is off for a printer that has not opted out, and saves it as off', async () => {
    serve(basePrinter);
    await openEditModal();

    expect(screen.getByLabelText(LABEL)).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toHaveProperty('keep_file_on_sd', false);
  });

  it('sends the choice when it is switched on', async () => {
    serve(basePrinter);
    await openEditModal();

    await userEvent.click(screen.getByLabelText(LABEL));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep file' }));
    expect(screen.getByLabelText(LABEL)).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toHaveProperty('keep_file_on_sd', true);
  });

  it('warns before switching on and leaves it off if cancelled', async () => {
    serve(basePrinter);
    await openEditModal();

    await userEvent.click(screen.getByLabelText(LABEL));
    expect(await screen.findByText(/start the last job again by themselves/i)).toBeInTheDocument();
    await userEvent.click((await screen.findAllByRole('button', { name: 'Cancel' })).at(-1)!);

    expect(screen.getByLabelText(LABEL)).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toHaveProperty('keep_file_on_sd', false);
  });

  it('shows a stored opt-out and can switch it back off', async () => {
    serve({ ...basePrinter, keep_file_on_sd: true });
    await openEditModal();

    const box = screen.getByLabelText(LABEL);
    expect(box).toBeChecked();

    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toHaveProperty('keep_file_on_sd', false);
  });
});
