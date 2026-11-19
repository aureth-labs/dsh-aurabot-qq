"""清理 DSH Desktop 累积的本地认证 Cookie。

由 Aurabot 插件在 DSH 退出时自动拉起。必须等 DSH Desktop 完全退出后再动
Cookies 数据库，否则 Chromium 会锁住 SQLite。只删除 host_key 为 localhost /
127.0.0.1 / ::1 且 name 为 dsh-auth-* 的 Cookie，其他 Cookie 一律保留。

单独使用：

    python clean-dsh-cookies.py --apply

可选：

    --wait-dsh             等 DeepSeek Harness.exe 全部退出后再执行
    --timeout 900          最多等待秒数
    --db PATH              指定 Cookies 数据库
    --backup-dir PATH      备份目录（默认数据库同目录）
    --log PATH             追加 JSON 日志
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

AUTH_FILTER = "host_key IN ('127.0.0.1', 'localhost', '[::1]', '::1') AND name GLOB 'dsh-auth-*'"
DSH_IMAGE = "DeepSeek Harness.exe"
BACKUP_PREFIX = "Cookies.before-dsh-auth-repair-"
MAX_BACKUPS = 5
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def default_database() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA is not set; cannot locate the DSH Cookies database")
    return Path(appdata) / "@deepseek-ai/dsh-desktop/Network/Cookies"


def tasklist_rows():
    tasklist = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/tasklist.exe"
    output = subprocess.run(
        [str(tasklist), "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        check=True,
        creationflags=CREATE_NO_WINDOW,
    ).stdout
    return [row for row in csv.reader(io.StringIO(output)) if row]


def dsh_running() -> bool:
    return any(row and row[0].casefold() == DSH_IMAGE.casefold() for row in tasklist_rows())


def pid_running(pid: int) -> bool:
    if not pid:
        return False
    tasklist = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/tasklist.exe"
    output = subprocess.run(
        [str(tasklist), "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
        capture_output=True,
        text=True,
        check=True,
        creationflags=CREATE_NO_WINDOW,
    ).stdout
    return any(len(row) > 1 and row[1].strip() == str(pid) for row in csv.reader(io.StringIO(output)))


def wait_for_dsh_exit(timeout: float, parent_pid: int = 0) -> bool:
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        if not dsh_running() and not pid_running(parent_pid):
            # tasklist 可能正好处在进程退出的竞态窗口，再给 Chromium 一点收尾时间。
            time.sleep(1.0)
            if not dsh_running() and not pid_running(parent_pid):
                return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.75)


def append_log(path, payload):
    if not path:
        return
    try:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        # 日志失败不能影响清理本身。
        pass


def safe_print(text, stream=None):
    """pythonw.exe 下 stdout/stderr 可能是 None；有控制台时仍输出 JSON 方便手测。"""
    target = stream or sys.stdout
    if target is None:
        return
    try:
        target.write(str(text) + "\n")
        target.flush()
    except Exception:
        pass


def open_database(database: Path, apply: bool, timeout: float) -> sqlite3.Connection:
    mode = "rw" if apply else "ro"
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        try:
            return sqlite3.connect(database.as_uri() + f"?mode={mode}", uri=True, timeout=30)
        except sqlite3.OperationalError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


def prune_backups(backup_dir: Path) -> None:
    try:
        backups = sorted(
            backup_dir.glob(BACKUP_PREFIX + "*.sqlite"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        for old in backups[MAX_BACKUPS:]:
            try:
                old.unlink()
            except OSError:
                pass
    except OSError:
        pass


def repair(database: Path, apply: bool, backup_dir: Path, wait: bool, timeout: float, parent_pid: int = 0) -> dict:
    if wait:
        if not wait_for_dsh_exit(timeout, parent_pid):
            raise RuntimeError("DeepSeek Harness is still running; nothing changed")
    if not database.is_file():
        return {
            "database": str(database),
            "mode": "apply" if apply else "inspect",
            "skipped": "database-not-found",
        }

    connection = open_database(database, apply, min(timeout, 30))
    try:
        integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
        if integrity != "ok":
            raise RuntimeError("Cookie database integrity check failed; nothing changed")

        cookie_count = connection.execute(
            f"SELECT count(*) FROM cookies WHERE {AUTH_FILTER}"
        ).fetchone()[0]
        other_count = connection.execute(
            f"SELECT count(*) FROM cookies WHERE NOT ({AUTH_FILTER})"
        ).fetchone()[0]
        report = {
            "database": str(database),
            "mode": "apply" if apply else "inspect",
            "integrity": integrity,
            "local_auth_cookies_before": cookie_count,
            "other_cookies": other_count,
        }
        if not apply or not cookie_count:
            report["removed"] = 0
            return report

        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        backup = backup_dir / f"{BACKUP_PREFIX}{stamp}.sqlite"
        with sqlite3.connect(backup) as destination:
            connection.backup(destination)
            if destination.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                try:
                    backup.unlink()
                except OSError:
                    pass
                raise RuntimeError("Backup integrity check failed; original unchanged")
        prune_backups(backup_dir)

        with connection:
            cursor = connection.execute(f"DELETE FROM cookies WHERE {AUTH_FILTER}")
            removed = cursor.rowcount
            after = connection.execute(
                f"SELECT count(*) FROM cookies WHERE {AUTH_FILTER}"
            ).fetchone()[0]
            remaining_other = connection.execute(
                f"SELECT count(*) FROM cookies WHERE NOT ({AUTH_FILTER})"
            ).fetchone()[0]
            if removed != cookie_count or after != 0 or remaining_other != other_count:
                raise RuntimeError("Cookie verification failed; transaction rolled back")

        report.update(
            backup=str(backup),
            removed=removed,
            local_auth_cookies_after=after,
        )
        return report
    finally:
        connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="备份并清理 local DSH auth cookies")
    parser.add_argument("--wait-dsh", action="store_true", help="等 DeepSeek Harness.exe 全部退出后再执行")
    parser.add_argument("--wait-pid", type=int, default=0, help="额外等待这个 DSH 进程退出，防进程名不一致")
    parser.add_argument("--timeout", type=float, default=900.0, help="等待/数据库重试秒数")
    parser.add_argument("--db", default="", help="Cookies 数据库路径")
    parser.add_argument("--backup-dir", default="", help="备份目录")
    parser.add_argument("--log", default="", help="追加 JSON 日志路径")
    args = parser.parse_args(argv)

    if os.name != "nt":
        safe_print("This cleanup currently supports Windows only.", sys.stderr)
        return 2

    try:
        database = Path(args.db) if args.db else default_database()
        backup_dir = Path(args.backup_dir) if args.backup_dir else database.parent
        report = repair(database, args.apply, backup_dir, args.wait_dsh, args.timeout, args.wait_pid)
        report["at"] = datetime.now().isoformat(timespec="seconds")
        append_log(args.log, report)
        safe_print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        failure = {
            "at": datetime.now().isoformat(timespec="seconds"),
            "ok": False,
            "error": str(error),
        }
        append_log(args.log, failure)
        safe_print(json.dumps(failure, ensure_ascii=False, indent=2), sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
