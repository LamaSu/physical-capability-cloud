"""Tests for the dynamic UI server, UI generator, and template system."""

import json
import os
import time
import threading
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

import pytest

from pcc_node.ui_server import (
    start_ui_server,
    get_submissions,
    pop_submission,
    clear_submissions,
)
from pcc_node.ui_gen import (
    generate_form_ui,
    generate_table_ui,
    generate_status_ui,
    install_template,
    list_templates,
    TEMPLATE_DIR,
)


# ---------- Fixtures ----------


@pytest.fixture()
def ui_dir(tmp_path):
    """Provide a temporary UI directory."""
    d = tmp_path / "ui"
    d.mkdir()
    return d


@pytest.fixture()
def server(ui_dir):
    """Start the UI server on a random-ish port for testing."""
    clear_submissions()
    # Use a port unlikely to be in use
    port = 13200 + os.getpid() % 1000
    srv = start_ui_server(
        port=port,
        ui_dir=str(ui_dir),
        background=True,
        pcc_base="",
        pcc_api_key="",
    )
    # Give the server thread a moment to bind
    time.sleep(0.2)
    yield {"server": srv, "port": port, "ui_dir": ui_dir}
    srv.shutdown()
    clear_submissions()


def _get(port, path):
    """GET a path from the test server, return (status, parsed_body)."""
    url = f"http://127.0.0.1:{port}{path}"
    req = Request(url, method="GET")
    try:
        with urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                return resp.status, raw
    except HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, raw


def _post(port, path, body, headers=None):
    """POST JSON to the test server, return (status, parsed_body)."""
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode("utf-8")
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = Request(url, data=data, headers=hdrs, method="POST")
    try:
        with urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                return resp.status, raw
    except HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            return e.code, raw


# ---------- Server Tests ----------


class TestUIServerHealth:
    def test_health_endpoint(self, server):
        status, body = _get(server["port"], "/api/health")
        assert status == 200
        assert body["status"] == "ok"
        assert body["port"] == server["port"]
        assert isinstance(body["files"], list)

    def test_health_shows_ui_dir(self, server):
        status, body = _get(server["port"], "/api/health")
        assert str(server["ui_dir"]) in body["ui_dir"]


class TestUIServerHub:
    def test_hub_page_empty(self, server):
        status, body = _get(server["port"], "/")
        assert status == 200
        assert "Active Interfaces" in body
        assert "No interfaces generated yet" in body

    def test_hub_page_lists_files(self, server):
        # Write an HTML file into the UI dir
        (server["ui_dir"] / "test-page.html").write_text("<h1>Hello</h1>")
        status, body = _get(server["port"], "/")
        assert status == 200
        assert "test-page" in body


class TestUIServerSubmissions:
    def test_submit_and_get(self, server):
        # POST a submission
        status, body = _post(
            server["port"],
            "/api/submit",
            {"name": "test", "value": 42},
            headers={"X-UI-Source": "test-form"},
        )
        assert status == 200
        assert body["received"] is True

        # GET submissions
        status, body = _get(server["port"], "/api/submissions")
        assert status == 200
        assert len(body["submissions"]) == 1
        assert body["submissions"][0]["data"]["name"] == "test"
        assert body["submissions"][0]["path"] == "test-form"

    def test_submit_multiple(self, server):
        _post(server["port"], "/api/submit", {"a": 1})
        _post(server["port"], "/api/submit", {"b": 2})
        _post(server["port"], "/api/submit", {"c": 3})

        status, body = _get(server["port"], "/api/submissions")
        assert len(body["submissions"]) == 3

    def test_pop_submission(self, server):
        _post(server["port"], "/api/submit", {"first": True})
        _post(server["port"], "/api/submit", {"second": True})

        # Pop first
        status, body = _get(server["port"], "/api/submissions/pop")
        assert status == 200
        assert body["submission"]["data"]["first"] is True

        # Pop second
        status, body = _get(server["port"], "/api/submissions/pop")
        assert body["submission"]["data"]["second"] is True

        # Pop empty
        status, body = _get(server["port"], "/api/submissions/pop")
        assert body["submission"] is None

    def test_pop_empty_queue(self, server):
        status, body = _get(server["port"], "/api/submissions/pop")
        assert status == 200
        assert body["submission"] is None

    def test_submission_has_timestamp(self, server):
        before = time.time()
        _post(server["port"], "/api/submit", {"x": 1})
        after = time.time()

        status, body = _get(server["port"], "/api/submissions")
        ts = body["submissions"][0]["timestamp"]
        assert before <= ts <= after


class TestUIServerGenerate:
    def test_generate_creates_file(self, server):
        status, body = _post(
            server["port"],
            "/api/generate",
            {
                "filename": "hello.html",
                "content": "<h1>Hello World</h1>",
            },
        )
        assert status == 201
        assert "hello.html" in body["url"]
        assert body["filename"] == "hello.html"

        # Verify file exists on disk
        filepath = server["ui_dir"] / "hello.html"
        assert filepath.exists()
        assert filepath.read_text() == "<h1>Hello World</h1>"

    def test_generate_serves_file(self, server):
        _post(
            server["port"],
            "/api/generate",
            {
                "filename": "test-gen.html",
                "content": "<html><body>Generated</body></html>",
            },
        )

        status, body = _get(server["port"], "/test-gen.html")
        assert status == 200
        assert "Generated" in body

    def test_generate_rejects_path_traversal(self, server):
        status, body = _post(
            server["port"],
            "/api/generate",
            {"filename": "../evil.html", "content": "bad"},
        )
        assert status == 400
        assert "Invalid filename" in body["error"]

    def test_generate_rejects_slashes(self, server):
        status, body = _post(
            server["port"],
            "/api/generate",
            {"filename": "sub/file.html", "content": "bad"},
        )
        assert status == 400

    def test_generate_shows_in_health(self, server):
        _post(
            server["port"],
            "/api/generate",
            {"filename": "widget.html", "content": "<div>Widget</div>"},
        )

        status, body = _get(server["port"], "/api/health")
        assert "widget.html" in body["files"]


class TestUIServerCORS:
    def test_options_returns_cors_headers(self, server):
        url = f"http://127.0.0.1:{server['port']}/api/submit"
        req = Request(url, method="OPTIONS")
        with urlopen(req, timeout=5) as resp:
            assert resp.status == 200
            assert resp.headers.get("Access-Control-Allow-Origin") == "*"
            assert "POST" in resp.headers.get("Access-Control-Allow-Methods", "")


class TestUIServer404:
    def test_unknown_api_returns_404(self, server):
        status, body = _get(server["port"], "/api/nonexistent")
        assert status == 404


# ---------- Module-level API Tests ----------


class TestModuleLevelAPI:
    def test_get_submissions_returns_list(self, server):
        _post(server["port"], "/api/submit", {"mod": True})
        subs = get_submissions()
        assert len(subs) >= 1
        assert subs[-1]["data"]["mod"] is True

    def test_pop_submission_returns_oldest(self, server):
        clear_submissions()
        _post(server["port"], "/api/submit", {"order": 1})
        _post(server["port"], "/api/submit", {"order": 2})

        sub = pop_submission()
        assert sub["data"]["order"] == 1

    def test_clear_submissions(self, server):
        _post(server["port"], "/api/submit", {"x": 1})
        clear_submissions()
        assert get_submissions() == []


# ---------- UI Generator Tests ----------


class TestGenerateFormUI:
    def test_basic_form(self, ui_dir):
        filename = generate_form_ui(
            "Test Form",
            [
                {"name": "name", "type": "text", "label": "Name"},
                {"name": "age", "type": "number", "label": "Age", "default": 25},
            ],
            ui_dir=str(ui_dir),
        )
        assert filename.endswith(".html")
        filepath = ui_dir / filename
        assert filepath.exists()
        content = filepath.read_text()
        assert "Test Form" in content
        assert 'name="name"' in content
        assert 'name="age"' in content

    def test_form_with_select(self, ui_dir):
        filename = generate_form_ui(
            "Select Form",
            [
                {
                    "name": "color",
                    "type": "select",
                    "label": "Color",
                    "options": ["red", "green", "blue"],
                    "default": "green",
                },
            ],
            ui_dir=str(ui_dir),
        )
        content = (ui_dir / filename).read_text()
        assert "<select" in content
        assert "red" in content
        assert "green" in content

    def test_form_with_checkbox(self, ui_dir):
        filename = generate_form_ui(
            "Checkbox Form",
            [{"name": "agree", "type": "checkbox", "label": "I agree", "default": True}],
            ui_dir=str(ui_dir),
        )
        content = (ui_dir / filename).read_text()
        assert 'type="checkbox"' in content
        assert "checked" in content

    def test_custom_filename(self, ui_dir):
        filename = generate_form_ui(
            "My Form",
            [{"name": "x", "type": "text", "label": "X"}],
            filename="custom.html",
            ui_dir=str(ui_dir),
        )
        assert filename == "custom.html"
        assert (ui_dir / "custom.html").exists()

    def test_form_contains_submit_js(self, ui_dir):
        filename = generate_form_ui(
            "JS Test",
            [{"name": "a", "type": "text", "label": "A"}],
            ui_dir=str(ui_dir),
        )
        content = (ui_dir / filename).read_text()
        assert "submitForm" in content
        assert "/api/submit" in content


class TestGenerateTableUI:
    def test_basic_table(self, ui_dir):
        filename = generate_table_ui(
            "Data Table",
            [{"key": "id", "label": "ID"}, {"key": "name", "label": "Name"}],
            [{"id": "1", "name": "Alpha"}, {"id": "2", "name": "Beta"}],
            ui_dir=str(ui_dir),
        )
        content = (ui_dir / filename).read_text()
        assert "Data Table" in content
        assert "Alpha" in content
        assert "Beta" in content
        assert "<table" in content

    def test_empty_table(self, ui_dir):
        filename = generate_table_ui(
            "Empty",
            [{"key": "x", "label": "X"}],
            [],
            ui_dir=str(ui_dir),
        )
        content = (ui_dir / filename).read_text()
        assert "No data" in content


class TestGenerateStatusUI:
    def test_basic_status(self, ui_dir):
        filename = generate_status_ui(
            "Node Status",
            [
                {"label": "Status", "value": "online", "badge": "green"},
                {"label": "Jobs", "value": "42"},
            ],
            ui_dir=str(ui_dir),
        )
        content = (ui_dir / filename).read_text()
        assert "Node Status" in content
        assert "online" in content
        assert "badge-green" in content

    def test_status_with_refresh(self, ui_dir):
        filename = generate_status_ui(
            "Live",
            [{"label": "Ping", "value": "ok"}],
            refresh_url="/api/health",
            ui_dir=str(ui_dir),
        )
        content = (ui_dir / filename).read_text()
        assert "setInterval" in content
        assert "/api/health" in content


# ---------- Template Tests ----------


class TestTemplates:
    def test_list_templates(self):
        templates = list_templates()
        assert "plate-layout" in templates
        assert "protocol-builder" in templates
        assert "job-status" in templates
        assert "camera-viewer" in templates
        assert "device-config" in templates

    def test_install_template(self, ui_dir):
        filename = install_template("plate-layout", ui_dir=str(ui_dir))
        assert filename == "plate-layout.html"
        installed = ui_dir / "plate-layout.html"
        assert installed.exists()
        content = installed.read_text()
        assert "96-Well" in content

    def test_install_unknown_template(self, ui_dir):
        with pytest.raises(FileNotFoundError):
            install_template("nonexistent-template", ui_dir=str(ui_dir))

    def test_template_files_are_self_contained(self):
        """All templates should have no external CDN links."""
        for name in list_templates():
            path = TEMPLATE_DIR / f"{name}.html"
            content = path.read_text()
            # No CDN or external stylesheet/script links
            assert "cdn." not in content.lower(), f"{name} has CDN reference"
            assert "unpkg.com" not in content.lower(), f"{name} has unpkg reference"
            assert "googleapis.com" not in content.lower(), f"{name} has googleapis reference"

    def test_template_files_under_500_lines(self):
        """All templates should be under 500 lines."""
        for name in list_templates():
            path = TEMPLATE_DIR / f"{name}.html"
            lines = path.read_text().count("\n") + 1
            assert lines <= 500, f"{name} has {lines} lines (max 500)"

    def test_template_files_have_dark_theme(self):
        """All templates should use the PCC dark theme."""
        for name in list_templates():
            path = TEMPLATE_DIR / f"{name}.html"
            content = path.read_text()
            assert "#0a0a0a" in content, f"{name} missing dark background"
            assert "#4ade80" in content, f"{name} missing accent color"

    def test_templates_post_to_api_submit(self):
        """All templates should post to /api/submit."""
        for name in list_templates():
            path = TEMPLATE_DIR / f"{name}.html"
            content = path.read_text()
            assert "/api/submit" in content, f"{name} missing /api/submit"
