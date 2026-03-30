"""UI generator -- create custom UIs from specs.

Agents call these functions to produce self-contained HTML files
that post user input back to the UI server.

All generated HTML uses:
  - Inline CSS (no external deps, no CDN)
  - Dark theme (#0a0a0a bg, #e0e0e0 text, #4ade80 accent)
  - Posts to http://localhost:{PORT}/api/submit with X-UI-Source header
"""

import json
import os
import shutil
from pathlib import Path

# Template directory ships inside the package
TEMPLATE_DIR = Path(__file__).parent / "ui_templates"

# Default output directory
DEFAULT_UI_DIR = Path.home() / ".pcc-node" / "ui"

# Base CSS shared across all generated UIs
_BASE_CSS = """
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #0a0a0a; color: #e0e0e0;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  padding: 2rem; line-height: 1.6;
}
h1 { color: #fff; font-size: 1.5rem; margin-bottom: 1.5rem; }
h2 { color: #ccc; font-size: 1.1rem; margin: 1.5rem 0 0.75rem; }
label { display: block; color: #aaa; font-size: 0.85rem; margin-bottom: 0.25rem; }
input, select, textarea {
  width: 100%; padding: 0.6rem 0.8rem; margin-bottom: 1rem;
  background: #111; border: 1px solid #333; border-radius: 4px;
  color: #e0e0e0; font-family: inherit; font-size: 0.9rem;
}
input:focus, select:focus, textarea:focus {
  outline: none; border-color: #4ade80;
}
input[type="number"] { width: 120px; }
input[type="range"] { width: 100%; }
button {
  background: #4ade80; color: #0a0a0a; border: none;
  padding: 0.75rem 1.5rem; border-radius: 4px; cursor: pointer;
  font-family: inherit; font-size: 0.9rem; font-weight: 700;
  margin-top: 0.5rem;
}
button:hover { background: #22c55e; }
button:disabled { background: #333; color: #666; cursor: not-allowed; }
.success { color: #4ade80; margin-top: 1rem; }
.error { color: #ef4444; margin-top: 1rem; }
table {
  width: 100%; border-collapse: collapse; margin: 1rem 0;
}
th { text-align: left; color: #4ade80; padding: 0.5rem; border-bottom: 2px solid #222; font-size: 0.85rem; }
td { padding: 0.5rem; border-bottom: 1px solid #1a1a1a; font-size: 0.85rem; }
tr:hover td { background: #111; }
.badge {
  display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px;
  font-size: 0.75rem; font-weight: 700;
}
.badge-green { background: #052e16; color: #4ade80; }
.badge-yellow { background: #422006; color: #fbbf24; }
.badge-red { background: #450a0a; color: #ef4444; }
"""

_SUBMIT_JS = """
function submitForm(formId, source) {
  var form = document.getElementById(formId);
  var data = {};
  var elements = form.elements;
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      data[el.name] = el.checked;
    } else if (el.type === 'number' || el.type === 'range') {
      data[el.name] = parseFloat(el.value);
    } else {
      data[el.name] = el.value;
    }
  }
  var port = window.location.port || '3200';
  fetch('http://localhost:' + port + '/api/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-UI-Source': source
    },
    body: JSON.stringify(data)
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      var msg = document.getElementById('status-msg');
      if (msg) { msg.className = 'success'; msg.textContent = 'Submitted successfully.'; }
    })
    .catch(function(e) {
      var msg = document.getElementById('status-msg');
      if (msg) { msg.className = 'error'; msg.textContent = 'Error: ' + e.message; }
    });
  return false;
}
"""


def _html_escape(s):
    """Minimal HTML escaping."""
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _make_field_html(field):
    """Generate HTML for a single form field."""
    name = _html_escape(field.get("name", ""))
    label = _html_escape(field.get("label", name))
    ftype = field.get("type", "text")
    default = field.get("default", "")
    required = "required" if field.get("required") else ""

    if ftype == "select":
        options = field.get("options", [])
        opts_html = ""
        for opt in options:
            sel = ' selected' if str(opt) == str(default) else ''
            opts_html += f'<option value="{_html_escape(opt)}"{sel}>{_html_escape(opt)}</option>\n'
        return f'<label for="{name}">{label}</label>\n<select id="{name}" name="{name}" {required}>\n{opts_html}</select>\n'

    elif ftype == "textarea":
        rows = field.get("rows", 4)
        return f'<label for="{name}">{label}</label>\n<textarea id="{name}" name="{name}" rows="{rows}" {required}>{_html_escape(default)}</textarea>\n'

    elif ftype == "checkbox":
        checked = "checked" if default else ""
        return f'<label><input type="checkbox" id="{name}" name="{name}" {checked} {required}> {label}</label><br><br>\n'

    elif ftype == "number":
        min_val = field.get("min", "")
        max_val = field.get("max", "")
        step = field.get("step", "any")
        min_attr = f' min="{min_val}"' if min_val != "" else ""
        max_attr = f' max="{max_val}"' if max_val != "" else ""
        return (
            f'<label for="{name}">{label}</label>\n'
            f'<input type="number" id="{name}" name="{name}" '
            f'value="{_html_escape(default)}" step="{step}"{min_attr}{max_attr} {required}>\n'
        )

    elif ftype == "range":
        min_val = field.get("min", 0)
        max_val = field.get("max", 100)
        step = field.get("step", 1)
        return (
            f'<label for="{name}">{label}: <span id="{name}-val">{_html_escape(default or min_val)}</span></label>\n'
            f'<input type="range" id="{name}" name="{name}" '
            f'min="{min_val}" max="{max_val}" step="{step}" '
            f'value="{_html_escape(default or min_val)}" '
            f'oninput="document.getElementById(\'{name}-val\').textContent=this.value" {required}>\n'
        )

    else:
        # text, email, url, etc.
        placeholder = _html_escape(field.get("placeholder", ""))
        return (
            f'<label for="{name}">{label}</label>\n'
            f'<input type="{ftype}" id="{name}" name="{name}" '
            f'value="{_html_escape(default)}" placeholder="{placeholder}" {required}>\n'
        )


def generate_form_ui(title, fields, submit_label="Submit", filename=None,
                     ui_dir=None):
    """Generate a form UI from a field spec.

    Parameters
    ----------
    title : str
        Page title / heading.
    fields : list[dict]
        Field definitions. Each dict has:
          - name (str): field name
          - type (str): text, number, select, textarea, checkbox, range
          - label (str): display label
          - default: default value
          - options (list): for select type
          - min, max, step: for number/range type
          - required (bool): mark as required
          - placeholder (str): for text inputs
    submit_label : str
        Button text.
    filename : str | None
        Output filename (default: form-{sanitized_title}.html)
    ui_dir : str | Path | None
        Output directory (default ~/.pcc-node/ui/)

    Returns
    -------
    str
        The filename written.
    """
    out_dir = Path(ui_dir) if ui_dir else DEFAULT_UI_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    if not filename:
        safe = title.lower().replace(" ", "-")
        safe = "".join(c for c in safe if c.isalnum() or c == "-")
        filename = f"form-{safe}.html"

    fields_html = ""
    for f in fields:
        fields_html += _make_field_html(f)

    source = filename.replace(".html", "")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_html_escape(title)}</title>
<style>{_BASE_CSS}</style>
</head>
<body>
<h1>{_html_escape(title)}</h1>
<form id="main-form" onsubmit="return submitForm('main-form', '{source}')">
{fields_html}
<button type="submit">{_html_escape(submit_label)}</button>
</form>
<div id="status-msg"></div>
<script>{_SUBMIT_JS}</script>
</body>
</html>"""

    (out_dir / filename).write_text(html, encoding="utf-8")
    return filename


def generate_table_ui(title, columns, data, filename=None, ui_dir=None):
    """Generate a data table UI.

    Parameters
    ----------
    title : str
        Page title.
    columns : list[dict]
        Column definitions: [{"key": "id", "label": "ID"}, ...]
    data : list[dict]
        Row data matching column keys.
    filename : str | None
        Output filename.
    ui_dir : str | Path | None
        Output directory.

    Returns
    -------
    str
        The filename written.
    """
    out_dir = Path(ui_dir) if ui_dir else DEFAULT_UI_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    if not filename:
        safe = title.lower().replace(" ", "-")
        safe = "".join(c for c in safe if c.isalnum() or c == "-")
        filename = f"table-{safe}.html"

    # Build table header
    th_html = ""
    for col in columns:
        th_html += f'<th>{_html_escape(col.get("label", col.get("key", "")))}</th>'

    # Build table rows
    rows_html = ""
    for row in data:
        rows_html += "<tr>"
        for col in columns:
            key = col.get("key", "")
            val = row.get(key, "")
            rows_html += f"<td>{_html_escape(val)}</td>"
        rows_html += "</tr>\n"

    if not rows_html:
        col_count = len(columns) or 1
        rows_html = f'<tr><td colspan="{col_count}" style="color:#666;text-align:center;">No data</td></tr>'

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_html_escape(title)}</title>
<style>{_BASE_CSS}</style>
</head>
<body>
<h1>{_html_escape(title)}</h1>
<table>
<thead><tr>{th_html}</tr></thead>
<tbody>{rows_html}</tbody>
</table>
</body>
</html>"""

    (out_dir / filename).write_text(html, encoding="utf-8")
    return filename


def generate_status_ui(title, sections, refresh_url=None, filename=None,
                       ui_dir=None):
    """Generate a live status dashboard.

    Parameters
    ----------
    title : str
        Page title.
    sections : list[dict]
        Section definitions: [{"label": "Status", "value": "online", "badge": "green"}, ...]
        badge can be: green, yellow, red (or omitted).
    refresh_url : str | None
        If provided, polls this URL and updates sections.
    filename : str | None
        Output filename.
    ui_dir : str | Path | None
        Output directory.

    Returns
    -------
    str
        The filename written.
    """
    out_dir = Path(ui_dir) if ui_dir else DEFAULT_UI_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    if not filename:
        safe = title.lower().replace(" ", "-")
        safe = "".join(c for c in safe if c.isalnum() or c == "-")
        filename = f"status-{safe}.html"

    sections_html = ""
    for i, sec in enumerate(sections):
        label = _html_escape(sec.get("label", ""))
        value = _html_escape(sec.get("value", ""))
        badge = sec.get("badge", "")
        badge_class = f" badge-{badge}" if badge in ("green", "yellow", "red") else ""

        if badge:
            value_html = f'<span class="badge{badge_class}" id="sec-{i}-val">{value}</span>'
        else:
            value_html = f'<span id="sec-{i}-val">{value}</span>'

        sections_html += (
            f'<div style="padding:0.75rem 0;border-bottom:1px solid #1a1a1a;">'
            f'<span style="color:#aaa;">{label}:</span> {value_html}</div>\n'
        )

    refresh_script = ""
    if refresh_url:
        refresh_script = f"""
<script>
setInterval(function() {{
  fetch('{refresh_url}')
    .then(function(r) {{ return r.json(); }})
    .then(function(data) {{
      if (data.sections) {{
        data.sections.forEach(function(sec, i) {{
          var el = document.getElementById('sec-' + i + '-val');
          if (el) el.textContent = sec.value || '';
        }});
      }}
    }})
    .catch(function() {{}});
}}, 3000);
</script>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_html_escape(title)}</title>
<style>{_BASE_CSS}</style>
</head>
<body>
<h1>{_html_escape(title)}</h1>
{sections_html}
{refresh_script}
</body>
</html>"""

    (out_dir / filename).write_text(html, encoding="utf-8")
    return filename


def install_template(template_name, ui_dir=None):
    """Copy a built-in template to the UI directory.

    Parameters
    ----------
    template_name : str
        Template name (without .html extension).
    ui_dir : str | Path | None
        Destination directory.

    Returns
    -------
    str
        Filename of the installed template.

    Raises
    ------
    FileNotFoundError
        If the template does not exist.
    """
    out_dir = Path(ui_dir) if ui_dir else DEFAULT_UI_DIR
    out_dir.mkdir(parents=True, exist_ok=True)

    src = TEMPLATE_DIR / f"{template_name}.html"
    if not src.exists():
        raise FileNotFoundError(f"Template not found: {template_name}")

    dest = out_dir / f"{template_name}.html"
    shutil.copy2(str(src), str(dest))
    return f"{template_name}.html"


def list_templates():
    """List available built-in templates.

    Returns
    -------
    list[str]
        Template names (without .html extension).
    """
    if not TEMPLATE_DIR.exists():
        return []
    return sorted(f.stem for f in TEMPLATE_DIR.glob("*.html"))
