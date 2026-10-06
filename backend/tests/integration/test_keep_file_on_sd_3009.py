"""A printer can keep its job file on the SD card after a print (#3009).

Bambuddy uploads each job to the SD card root and, once the print finishes,
deletes it again so a P1S/A1 cannot restart it by itself after a power cycle
(#374, #1542). The same deletion removes the only copy the printer could
reprint from its own screen, and on some firmware the printer then names the
missing file after power-on and raises 0500-C010.

``keep_file_on_sd`` lets a printer opt out of that post-print sweep. It is off
by default, so nothing changes on upgrade.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

pytestmark = pytest.mark.integration


async def _complete_print(test_engine, printer, delete_mock):
    """Run the real on_print_complete for ``printer`` with the FTP delete mocked.

    Everything that talks to the outside world is replaced; the printer row is
    read from a real database, so the flag really comes off the column.
    """
    from backend.app.services.bambu_ftp import DeleteResult

    delete_mock.return_value = DeleteResult.DELETED
    maker = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)
    tasks_before = set(asyncio.all_tasks())

    with (
        patch("backend.app.main.async_session", maker),
        patch("backend.app.main.notification_service") as notif,
        patch("backend.app.main.smart_plug_manager") as plug,
        patch("backend.app.main.ws_manager") as ws,
        patch("backend.app.main.mqtt_relay") as relay,
        patch("backend.app.main.printer_manager") as pm,
        patch("backend.app.services.bambu_ftp.delete_file_async", delete_mock),
    ):
        notif.on_print_complete = AsyncMock()
        plug.on_print_complete = AsyncMock()
        ws.send_print_complete = AsyncMock()
        ws.broadcast = AsyncMock()
        relay.on_print_complete = AsyncMock()
        pm.get_printer.return_value = None
        pm.get_status.return_value = MagicMock()

        from backend.app.main import on_print_complete

        await on_print_complete(
            printer.id,
            {
                "status": "completed",
                "filename": "/data/Metadata/Cube.gcode",
                "subtask_name": "Cube",
                "timelapse_was_active": False,
            },
        )

        # Background tasks opened by on_print_complete must not outlive the mocks.
        for task in asyncio.all_tasks() - tasks_before:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass


@pytest.mark.asyncio
class TestPostPrintCleanup:
    async def test_file_is_deleted_by_default(self, test_engine, printer_factory):
        """The existing behaviour is untouched when the option is not set."""
        printer = await printer_factory()
        assert printer.keep_file_on_sd is False

        delete = AsyncMock()
        await _complete_print(test_engine, printer, delete)

        deleted = [call.args[2] for call in delete.await_args_list]
        assert "/Cube.3mf" in deleted

    async def test_file_is_kept_when_the_printer_opts_out(self, test_engine, printer_factory):
        printer = await printer_factory(keep_file_on_sd=True)

        delete = AsyncMock()
        await _complete_print(test_engine, printer, delete)

        delete.assert_not_awaited()

    async def test_the_option_is_per_printer(self, test_engine, printer_factory):
        """Opting one printer out leaves the others' cleanup alone."""
        keeper = await printer_factory(keep_file_on_sd=True)
        other = await printer_factory()

        keeper_delete, other_delete = AsyncMock(), AsyncMock()
        await _complete_print(test_engine, keeper, keeper_delete)
        await _complete_print(test_engine, other, other_delete)

        keeper_delete.assert_not_awaited()
        other_delete.assert_awaited()


@pytest.mark.asyncio
class TestPrinterApi:
    async def test_defaults_to_off(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()

        response = await async_client.get(f"/api/v1/printers/{printer.id}")

        assert response.status_code == 200
        assert response.json()["keep_file_on_sd"] is False

    async def test_can_be_switched_on_and_off(self, async_client: AsyncClient, printer_factory):
        printer = await printer_factory()

        on = await async_client.patch(f"/api/v1/printers/{printer.id}", json={"keep_file_on_sd": True})
        assert on.status_code == 200
        assert on.json()["keep_file_on_sd"] is True
        assert (await async_client.get(f"/api/v1/printers/{printer.id}")).json()["keep_file_on_sd"] is True

        off = await async_client.patch(f"/api/v1/printers/{printer.id}", json={"keep_file_on_sd": False})
        assert off.json()["keep_file_on_sd"] is False

    async def test_other_updates_do_not_reset_it(self, async_client: AsyncClient, printer_factory):
        """The Edit dialog PATCHes only what it sends; an unrelated edit from
        another client must not flip the option back."""
        printer = await printer_factory(keep_file_on_sd=True)

        response = await async_client.patch(f"/api/v1/printers/{printer.id}", json={"name": "Renamed"})

        assert response.json()["keep_file_on_sd"] is True
