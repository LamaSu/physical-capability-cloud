#!/usr/bin/env python3
"""Parse brsynth/galaxytools Galaxy tool XMLs into a normalized PCC capability catalog.

Deterministic. Only elements whose root tag is <tool> become capabilities (this
auto-filters macros.xml, *_conf.xml, and SBML model files). For every tool we emit:
  - nested `inputs` + flattened `inputs_flat` (dotted paths: `adv.topx`, `sink.sinkfile`)
  - `outputs`
  - `input_schema` / `output_schema`  — JSON Schema (Draft-07) an agent can validate against
  - `stage` (pipeline position) + `status` + optional `superseded_by`
Galaxy <expand macro="..."/> references inside <inputs> are resolved from the tool's
co-located macros.xml so param specs are complete (e.g. the straindesign tools).
"""
import os, json, glob, subprocess
import xml.etree.ElementTree as ET
from collections import Counter

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(ROOT, "galaxytools")

STAGE_BY_CATEGORY = {
    "retropath2": "retrosynthesis", "retrorules": "retrosynthesis", "rrparser": "retrosynthesis",
    "rp2paths": "retrosynthesis", "rpcompletion": "retrosynthesis", "rpcomletion": "retrosynthesis",
    "rpextractsink": "retrosynthesis", "inchi_to_sink": "retrosynthesis", "rp2biosensor": "biosensor-design",
    "molecule-signature": "cheminformatics",
    "rpthermo": "pathway-analysis", "straindesign": "pathway-analysis",
    "selenzy_wrapper": "enzyme-selection",
    "sbml2sbol": "genetic-design", "sbol_converter": "genetic-design", "sbol3_diff": "genetic-design",
    "partsgenie": "genetic-design", "doe_synbio": "genetic-design", "rpbasicdesign": "genetic-design",
    "domestication_of_new_parts": "genetic-design", "sculpt_sequences": "genetic-design",
    "dnaweaver": "dna-assembly", "dnabot": "dna-assembly", "lcrgenie": "dna-assembly",
    "cloning_simulation": "dna-assembly", "create_assembly_picklists": "dna-assembly",
    "evaluate_manufacturability": "dna-assembly",
    "icfree": "cell-free", "amn": "ml-modeling", "damn": "ml-modeling",
    "get_sbml_model": "data-io", "get_from_db": "data-io", "save_to_db": "data-io",
    "seq_from_db": "data-io", "seq_to_db": "data-io", "neo4jsbml": "data-io",
    "parameters_maystro": "workflow-params", "draft": "draft",
}
STAGE_BY_ID = {
    "rptools_rpcompletion": "retrosynthesis", "rptools_rpextractsink": "retrosynthesis",
    "rptools_rpfba": "pathway-analysis", "rptools_rpthermo": "pathway-analysis",
    "rptools_rpranker": "pathway-analysis", "rptools_rpscore": "pathway-analysis",
    "rptools_rpreport": "reporting", "rptools_rpviz": "reporting",
}
# older standalone wrappers folded into the rptools suite
SUPERSEDED = {
    "rpcompletion": "rptools_rpcompletion", "rpcomletion": "rptools_rpcompletion",
    "rpthermo": "rptools_rpthermo", "rpextractsink": "rptools_rpextractsink",
}


def norm(s):
    if s is None:
        return None
    s = " ".join(s.split()).strip()
    return s or None


def load_macros(xml_path):
    d = {}
    mp = os.path.join(os.path.dirname(xml_path), "macros.xml")
    if os.path.exists(mp):
        try:
            for x in ET.parse(mp).getroot().findall("xml"):
                d[x.get("name")] = list(x)
        except ET.ParseError:
            pass
    return d


def parse_param(el):
    p = {"name": el.get("name"), "type": el.get("type")}
    fmt = el.get("format")
    if fmt:
        p["format"] = [f.strip() for f in fmt.split(",") if f.strip()]
    if el.get("value") is not None:
        p["default"] = el.get("value")
    for a in ("min", "max"):
        if el.get(a) is not None:
            p[a] = el.get(a)
    if el.get("optional") is not None:
        p["optional"] = el.get("optional").lower() == "true"
    if el.get("type") == "boolean":
        p["checked_default"] = el.get("checked") == "true"
        if el.get("truevalue") is not None:
            p["truevalue"] = el.get("truevalue")
        if el.get("falsevalue") is not None:
            p["falsevalue"] = el.get("falsevalue")
    if el.get("label"):
        p["label"] = norm(el.get("label"))
    if el.get("help"):
        p["help"] = norm(el.get("help"))
    opts = [{"value": o.get("value"), "label": norm(o.text), "selected": o.get("selected") == "true"}
            for o in el.findall("option")]
    if opts:
        p["options"] = opts
    vals = [{"type": v.get("type"), "message": norm(v.get("message")), "expr": norm(v.text)}
            for v in el.findall("validator")]
    if vals:
        p["validators"] = vals
    if el.get("type") == "data":
        p["required"] = el.get("optional", "false").lower() != "true"
    return p


def parse_inputs(container, macros):
    items = []
    for el in list(container):
        tag = el.tag
        if tag == "param":
            items.append(parse_param(el))
        elif tag == "conditional":
            sel = el.find("param")
            cond = {"name": el.get("name"), "type": "conditional"}
            if sel is not None:
                cond["selector"] = parse_param(sel)
            cond["cases"] = {w.get("value"): parse_inputs(w, macros) for w in el.findall("when")}
            items.append(cond)
        elif tag == "section":
            items.append({"name": el.get("name"), "type": "section",
                          "title": norm(el.get("title")), "params": parse_inputs(el, macros)})
        elif tag == "repeat":
            items.append({"name": el.get("name"), "type": "repeat",
                          "title": norm(el.get("title")), "params": parse_inputs(el, macros)})
        elif tag == "expand":
            name = el.get("macro")
            if name in macros:
                items.extend(parse_inputs(macros[name], macros))  # splice macro children
            else:
                items.append({"type": "expand", "macro": name, "unresolved": True})
    return items


def parse_outputs(container):
    outs = []
    for el in list(container):
        if el.tag in ("data", "collection"):
            o = {"name": el.get("name"), "kind": el.tag}
            if el.get("format"):
                o["format"] = el.get("format")
            if el.get("label"):
                o["label"] = norm(el.get("label"))
            for act in el.findall(".//action"):
                if act.get("name") == "column_names" and act.get("default"):
                    o["column_names"] = [c.strip() for c in act.get("default").split(",")]
            f = el.find("filter")
            if f is not None and f.text:
                o["conditional_on"] = norm(f.text)
            if el.tag == "collection":
                o["collection_type"] = el.get("type")
            outs.append(o)
    return outs


def flatten(items, prefix=""):
    flat = []
    for it in items:
        t, name = it.get("type"), it.get("name")
        if t == "conditional":
            sel = dict(it.get("selector") or {})
            sel["path"] = f"{prefix}{name}"
            sel["role"] = "conditional-selector"
            flat.append(sel)
            for _cval, sub in it.get("cases", {}).items():
                flat.extend(flatten(sub, prefix=f"{prefix}{name}."))
        elif t in ("section", "repeat"):
            flat.extend(flatten(it.get("params", []), prefix=f"{prefix}{name}."))
        elif t == "expand":
            flat.append({"path": f"{prefix}<expand:{it.get('macro')}>", "role": "expand"})
        else:
            leaf = dict(it)
            leaf["path"] = f"{prefix}{name}" if name else prefix.rstrip(".")
            flat.append(leaf)
    return flat


JSON_TYPE = {"integer": "integer", "float": "number", "boolean": "boolean",
             "text": "string", "select": "string", "data": "string",
             "data_collection": "array", "color": "string", "hidden": "string"}


def to_json_schema(flat):
    props, required = {}, []
    for p in flat:
        if p.get("role") == "expand":
            continue
        path = p.get("path")
        if not path:
            continue
        t = p.get("type")
        js = {"type": JSON_TYPE.get(t, "string")}
        desc = " — ".join(x for x in (p.get("label"), p.get("help")) if x)
        if desc:
            js["description"] = desc[:300]
        if t in ("integer", "float"):
            if p.get("min") is not None:
                try: js["minimum"] = float(p["min"]) if t == "float" else int(p["min"])
                except ValueError: pass
            if p.get("max") is not None:
                try: js["maximum"] = float(p["max"]) if t == "float" else int(p["max"])
                except ValueError: pass
        if p.get("options"):
            js["enum"] = [o["value"] for o in p["options"]]
            sel = [o["value"] for o in p["options"] if o.get("selected")]
            if sel:
                js["default"] = sel[0]
        if p.get("default") is not None and "default" not in js:
            dv = p["default"]
            if t == "integer":
                try: dv = int(dv)
                except ValueError: pass
            elif t == "float":
                try: dv = float(dv)
                except ValueError: pass
            js["default"] = dv
        if t == "boolean":
            js["default"] = bool(p.get("checked_default"))
        if t == "data":
            fmts = p.get("format") or []
            if fmts:
                js["x-galaxy-datatype"] = fmts
                js["contentMediaType"] = {"sbml": "application/xml", "sbol": "application/xml",
                                          "xml": "application/xml", "json": "application/json",
                                          "csv": "text/csv", "tabular": "text/tab-separated-values",
                                          "tsv": "text/tab-separated-values"}.get(fmts[0], "application/octet-stream")
            js["x-galaxy-kind"] = "dataset-ref"
        props[path] = js
        # top-level (no dotted prefix) required params only — nested ones are conditional
        if "." not in path and p.get("role") != "conditional-selector":
            is_req = p.get("required") is True or (
                t in ("text", "integer", "float") and p.get("optional") is not True
                and p.get("default") in (None, "")
                and any(v.get("type") == "empty_field" for v in (p.get("validators") or [])))
            if is_req:
                required.append(path)
    schema = {"$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": props}
    if required:
        schema["required"] = sorted(set(required))
    return schema


def output_schema(outputs):
    props = {}
    for o in outputs:
        name = o.get("name")
        if not name:
            continue
        js = {"type": "array" if o.get("kind") == "collection" else "string", "x-galaxy-kind": "dataset-ref"}
        if o.get("format"):
            js["x-galaxy-datatype"] = o["format"]
        if o.get("label"):
            js["description"] = o["label"][:300]
        if o.get("column_names"):
            js["x-columns"] = o["column_names"]
        if o.get("conditional_on"):
            js["x-conditional-on"] = o["conditional_on"]
        props[name] = js
    return {"$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": props}


def main():
    try:
        sha = subprocess.run(["git", "-C", REPO, "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True).stdout.strip()
    except Exception:
        sha = "unknown"

    paths = sorted(glob.glob(os.path.join(REPO, "tools", "**", "*.xml"), recursive=True) +
                   glob.glob(os.path.join(REPO, "drafts", "**", "*.xml"), recursive=True))
    tools, skipped = [], []
    for path in paths:
        if "test-data" in path.replace("\\", "/"):
            continue
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError:
            continue
        if root.tag != "tool":
            skipped.append(os.path.relpath(path, REPO))
            continue
        rel = os.path.relpath(path, REPO).replace("\\", "/")
        macros = load_macros(path)
        inputs_el, outputs_el = root.find("inputs"), root.find("outputs")
        inp = parse_inputs(inputs_el, macros) if inputs_el is not None else []
        out = parse_outputs(outputs_el) if outputs_el is not None else []
        reqs = [{"type": r.get("type"), "version": r.get("version"), "package": norm(r.text)}
                for r in root.findall(".//requirement")]
        cites = [norm(c.text) for c in root.findall(".//citation") if c.get("type") == "doi"]
        h = root.find("help")
        helptext = norm(h.text) if h is not None and h.text else None
        if helptext and len(helptext) > 600:
            helptext = helptext[:600] + "…"
        flat = flatten(inp)
        desc_el = root.find("description")
        category = rel.split("/")[1] if rel.startswith("tools/") else "draft"
        tid = root.get("id")
        stage = STAGE_BY_ID.get(tid) or STAGE_BY_CATEGORY.get(category, "other")
        status = "draft" if category == "draft" else ("experimental" if category == "parameters_maystro" else "stable")
        unresolved = any(x.get("role") == "expand" for x in flat)
        rec = {
            "id": tid,
            "name": root.get("name"),
            "version": root.get("version"),
            "profile": root.get("profile"),
            "stage": stage,
            "status": status,
            "category": category,
            "source_xml": rel,
            "description": norm(desc_el.text) if desc_el is not None else None,
            "requirements": reqs,
            "citations": cites,
            "inputs": inp,
            "inputs_flat": flat,
            "outputs": out,
            "input_schema": to_json_schema(flat),
            "output_schema": output_schema(out),
            "help": helptext,
            "n_inputs": len([f for f in flat if f.get("role") not in ("conditional-selector", "expand")]),
            "n_outputs": len(out),
        }
        if tid in SUPERSEDED:
            rec["superseded_by"] = SUPERSEDED[tid]
            rec["status"] = "deprecated"
        if unresolved:
            rec["unresolved_macros"] = True
        tools.append(rec)

    idc = Counter(t["id"] for t in tools)
    dupes = {k: v for k, v in idc.items() if v > 1}
    by_stage = Counter(t["stage"] for t in tools)

    catalog = {
        "$schema_note": "Each tool.input_schema / output_schema is JSON Schema Draft-07.",
        "source": "https://github.com/brsynth/galaxytools",
        "commit": sha,
        "provider": "galaxy-synbiocad",
        "standards": ["SBML", "SBOL", "InChI", "SMILES", "CSV", "tabular"],
        "tool_count": len(tools),
        "stages": dict(by_stage),
        "duplicate_ids": dupes,
        "tools": tools,
    }
    outp = os.path.join(ROOT, "galaxy-synbiocad-catalog.json")
    with open(outp, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    print(f"commit={sha}  tools={len(tools)}  "
          f"input_params={sum(t['n_inputs'] for t in tools)}  outputs={sum(t['n_outputs'] for t in tools)}")
    print(f"unresolved_macro_tools={[t['id'] for t in tools if t.get('unresolved_macros')]}")
    print("stages:", json.dumps(dict(by_stage)))
    print("\n{:<26} {:<30} {:>3} {:>3}  {}".format("stage", "id", "in", "out", "status"))
    print("-" * 78)
    for t in sorted(tools, key=lambda x: (x["stage"], x["id"] or "")):
        print("{:<26} {:<30} {:>3} {:>3}  {}".format(
            t["stage"], str(t["id"]), t["n_inputs"], t["n_outputs"],
            t["status"] + (f" ->{t['superseded_by']}" if t.get("superseded_by") else "")))
    print(f"\nWROTE {outp}  ({os.path.getsize(outp)//1024} KB)")


if __name__ == "__main__":
    main()
