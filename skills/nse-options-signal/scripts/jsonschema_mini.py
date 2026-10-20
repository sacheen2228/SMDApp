#!/usr/bin/env python3
"""Minimal JSON Schema validator (draft 2020-12 subset) - stdlib only.

The skill has no third-party dependencies, so `jsonschema` is not available.
This module implements the subset actually used by the skill's schemas
(references/gex-output-schema.json, references/orchestrator-output-schema.json):

    type, required, properties, additionalProperties, enum, const,
    minimum, maximum, exclusiveMinimum, exclusiveMaximum,
    items, minItems, maxItems, oneOf, anyOf, allOf,
    if/then/else, pattern, $ref (local JSON pointers), $defs, format (date/date-time)

Anything else in a schema is ignored (documented, not silently "passed" as a
failure): a schema construct this validator does not understand is skipped, so
callers must not treat "no errors" as "fully conformant" for exotic schemas.

Usage:
    from jsonschema_mini import validate
    errors = validate(instance, schema)      # -> list of "path: message" strings
"""
import re

__all__ = ["validate", "is_valid", "SchemaError"]


class SchemaError(Exception):
    """Raised when the schema itself is malformed (not the instance)."""


_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "null": type(None),
}


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_integer(v):
    if isinstance(v, bool):
        return False
    if isinstance(v, int):
        return True
    return isinstance(v, float) and float(v).is_integer()


def _type_ok(value, tname):
    if tname == "number":
        return _is_number(value)
    if tname == "integer":
        return _is_integer(value)
    if tname == "boolean":
        return isinstance(value, bool)
    expected = _TYPES.get(tname)
    if expected is None:
        return True  # unknown type name -> not enforced
    if expected is dict or expected is list or expected is str:
        return isinstance(value, expected)
    return isinstance(value, expected)


def _resolve(ref, root):
    if not isinstance(ref, str) or not ref.startswith("#"):
        raise SchemaError("only local $ref is supported: %r" % (ref,))
    node = root
    for part in ref.lstrip("#").split("/"):
        if part == "":
            continue
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            node = node[int(part)]
        else:
            if part not in node:
                raise SchemaError("unresolvable $ref: %r" % (ref,))
            node = node[part]
    return node


def _fmt_ok(value, fmt):
    if not isinstance(value, str):
        return True
    if fmt == "date":
        return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", value))
    if fmt == "date-time":
        return bool(re.match(r"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?"
                             r"([Zz]|[+-]\d{2}:?\d{2})?$", value))
    return True


def _validate(value, schema, root, path, errors):
    if schema is True or schema == {}:
        return
    if schema is False:
        errors.append("%s: schema forbids any value" % path)
        return
    if not isinstance(schema, dict):
        raise SchemaError("schema must be an object or boolean at %s" % path)

    if "$ref" in schema:
        target = _resolve(schema["$ref"], root)
        _validate(value, target, root, path, errors)
        # sibling keywords next to $ref are still applied (2020-12 semantics)

    if "type" in schema:
        tnames = schema["type"]
        if isinstance(tnames, str):
            tnames = [tnames]
        if not any(_type_ok(value, t) for t in tnames):
            errors.append("%s: expected type %s, got %s" %
                          (path, "|".join(tnames), type(value).__name__))
            return

    if "const" in schema and value != schema["const"]:
        errors.append("%s: expected const %r, got %r" % (path, schema["const"], value))
    if "enum" in schema and value not in schema["enum"]:
        errors.append("%s: %r is not one of %r" % (path, value, schema["enum"]))

    if _is_number(value):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append("%s: %r < minimum %r" % (path, value, schema["minimum"]))
        if "maximum" in schema and value > schema["maximum"]:
            errors.append("%s: %r > maximum %r" % (path, value, schema["maximum"]))
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errors.append("%s: %r <= exclusiveMinimum %r" % (path, value, schema["exclusiveMinimum"]))
        if "exclusiveMaximum" in schema and value >= schema["exclusiveMaximum"]:
            errors.append("%s: %r >= exclusiveMaximum %r" % (path, value, schema["exclusiveMaximum"]))

    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append("%s: %r does not match pattern %r" % (path, value, schema["pattern"]))
        if "format" in schema and not _fmt_ok(value, schema["format"]):
            errors.append("%s: %r is not a valid %s" % (path, value, schema["format"]))

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append("%s: has %d items, minItems %d" % (path, len(value), schema["minItems"]))
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append("%s: has %d items, maxItems %d" % (path, len(value), schema["maxItems"]))
        if "items" in schema:
            for i, item in enumerate(value):
                _validate(item, schema["items"], root, "%s[%d]" % (path, i), errors)

    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append("%s: missing required property %r" % (path, key))
        props = schema.get("properties", {})
        for key, sub in props.items():
            if key in value:
                _validate(value[key], sub, root, "%s.%s" % (path, key), errors)
        addl = schema.get("additionalProperties")
        if addl is False:
            extra = [k for k in value if k not in props]
            if extra:
                errors.append("%s: additional properties not allowed: %s" % (path, ", ".join(sorted(extra))))
        elif isinstance(addl, dict):
            for key in value:
                if key not in props:
                    _validate(value[key], addl, root, "%s.%s" % (path, key), errors)

    if "allOf" in schema:
        for i, sub in enumerate(schema["allOf"]):
            _validate(value, sub, root, "%s(allOf[%d])" % (path, i), errors)

    if "anyOf" in schema:
        if not any(not _collect(value, sub, root, path) for sub in schema["anyOf"]):
            errors.append("%s: does not match any of the anyOf branches" % path)

    if "oneOf" in schema:
        matches = [i for i, sub in enumerate(schema["oneOf"])
                   if not _collect(value, sub, root, path)]
        if len(matches) != 1:
            errors.append("%s: matched %d oneOf branches (exactly 1 required)" % (path, len(matches)))

    if "if" in schema:
        cond_ok = not _collect(value, schema["if"], root, path)
        branch = schema.get("then") if cond_ok else schema.get("else")
        if branch is not None:
            _validate(value, branch, root, "%s(if/then)" % path, errors)


def _collect(value, schema, root, path):
    errs = []
    _validate(value, schema, root, path, errs)
    return errs


def validate(instance, schema):
    """Return a list of human-readable error strings ([] == valid)."""
    errors = []
    _validate(instance, schema, schema, "$", errors)
    return errors


def is_valid(instance, schema):
    return not validate(instance, schema)


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) != 3:
        print("usage: jsonschema_mini.py <instance.json> <schema.json>")
        raise SystemExit(2)
    with open(sys.argv[1]) as fh:
        inst = json.load(fh)
    with open(sys.argv[2]) as fh:
        sch = json.load(fh)
    errs = validate(inst, sch)
    if errs:
        for e in errs:
            print("SCHEMA ERROR:", e)
        raise SystemExit(1)
    print("valid")
