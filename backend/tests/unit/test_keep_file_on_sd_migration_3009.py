"""Migration coverage for the per-printer ``keep_file_on_sd`` option (#3009)."""

import importlib
import pkgutil

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

import backend.app.models as _models
from backend.app.core.database import Base, run_migrations

# run_migrations alters tables (virtual_printers, external_links, ...) that
# create_all() only builds once their model module has been imported, so load
# every one rather than keeping a list that goes stale.
for _module in pkgutil.iter_modules(_models.__path__):
    importlib.import_module(f"{_models.__name__}.{_module.name}")


@pytest.fixture(autouse=True)
def force_sqlite_dialect(monkeypatch):
    """run_migrations branches on the global dialect, not on the connection."""
    from backend.app.core import database as database_module, db_dialect

    monkeypatch.setattr(db_dialect, "is_sqlite", lambda: True)
    monkeypatch.setattr(db_dialect, "is_postgres", lambda: False)
    monkeypatch.setattr(database_module, "is_sqlite", lambda: True)


@pytest.mark.asyncio
async def test_existing_printers_keep_the_cleanup_after_upgrade(tmp_path):
    """A database from before the option has no such column. Upgrading must add
    it as off, so no printer silently stops cleaning its SD card."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'keep-file.db'}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            # Rebuild the pre-upgrade shape: the column did not exist yet.
            await conn.execute(text("ALTER TABLE printers DROP COLUMN keep_file_on_sd"))
            await conn.execute(
                text(
                    "INSERT INTO printers (name, serial_number, ip_address, access_code, is_active, auto_archive, "
                    "nozzle_count, print_hours_offset, runtime_seconds, awaiting_plate_clear, camera_rotation, "
                    "external_camera_enabled, camera_light_auto, plate_detection_enabled) "
                    "VALUES ('Old', '00M09A000000001', '192.168.1.50', '12345678', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0)"
                )
            )

            await run_migrations(conn)

            columns = {row[1] for row in (await conn.execute(text("PRAGMA table_info(printers)"))).all()}
            kept = await conn.scalar(text("SELECT keep_file_on_sd FROM printers WHERE name = 'Old'"))

        assert "keep_file_on_sd" in columns
        assert kept == 0
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_migration_is_safe_to_run_twice_and_keeps_a_chosen_value(tmp_path):
    """Migrations run on every start; a second pass must not reset the choice."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'keep-file-twice.db'}")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await run_migrations(conn)
            await conn.execute(
                text(
                    "INSERT INTO printers (name, serial_number, ip_address, access_code, is_active, auto_archive, "
                    "nozzle_count, print_hours_offset, runtime_seconds, awaiting_plate_clear, camera_rotation, "
                    "external_camera_enabled, camera_light_auto, plate_detection_enabled, keep_file_on_sd) "
                    "VALUES ('Keeper', '00M09A000000002', '192.168.1.51', '12345678', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1)"
                )
            )

            await run_migrations(conn)

            kept = await conn.scalar(text("SELECT keep_file_on_sd FROM printers WHERE name = 'Keeper'"))

        assert kept == 1
    finally:
        await engine.dispose()
