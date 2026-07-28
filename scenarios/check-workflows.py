#!/usr/bin/env python3
"""Reject a workflow GitHub would reject, which PyYAML happily accepts.

A duplicate key is fine by PyYAML - last one wins - and a hard error for Actions:
a run appears with zero jobs and a bare 'failure', which says nothing about why.
That happened twice here, so the check is strict about duplicates and is meant to
run before pushing.
"""
import sys, yaml

class Strict(yaml.SafeLoader):
    pass

def no_duplicates(loader, node, deep=False):
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            mark = key_node.start_mark
            raise yaml.YAMLError(
                f"duplicate key '{key}' at line {mark.line + 1}, column {mark.column + 1}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping

Strict.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, no_duplicates)

failed = False
for path in sys.argv[1:]:
    try:
        doc = yaml.load(open(path), Strict)
        jobs = list((doc or {}).get("jobs", {}))
        missing = [j for j, v in (doc or {}).get("jobs", {}).items() if "timeout-minutes" not in v]
        print(f"{path}: ok, jobs: {', '.join(jobs)}")
        if missing:
            print(f"  no deadline on: {', '.join(missing)} - a hang there costs a whole runner")
            failed = True
    except yaml.YAMLError as e:
        print(f"{path}: INVALID - {e}")
        failed = True

sys.exit(1 if failed else 0)
