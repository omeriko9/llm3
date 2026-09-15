#!/usr/bin/env python3
"""Catch local variables used before they are assigned.

Written after a real failure: a refactor moved a computation below the code that
consumed it, `python3 -m py_compile` was happy, and every benchmark run since
crashed at the end of its quality step -- after doing all the work. Nothing else
in this repo lints Python, so this is the smallest thing that would have caught
it.

It is deliberately conservative: it reports a name only when the earliest
assignment to it in a function body comes after the earliest use, and it walks
one scope at a time. That misses some real bugs (anything behind a branch) and
is meant to report no false positives, so it can gate `npm run lint`.

Scope handling is the part that matters. A comprehension has its own scope in
Python 3, so in `[option for option in options]` the `option` on the left is not
the same binding as a name in the enclosing function -- and because the element
expression is written before the `for` clause, a naive walk sees a use at a line
before its assignment and reports every comprehension in the file. Nested
functions, lambdas, and classes are separate scopes for the same reason. This
walker stops at all of them.

Run: python3 benchmarks/check_use_before_assign.py FILE...
     python3 benchmarks/check_use_before_assign.py --selftest
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

# Nodes that introduce a scope of their own. Names bound inside one are not
# bindings of the enclosing function, so the walk does not descend into them.
SCOPE_NODES = (
    ast.FunctionDef,
    ast.AsyncFunctionDef,
    ast.Lambda,
    ast.ClassDef,
    ast.ListComp,
    ast.SetComp,
    ast.DictComp,
    ast.GeneratorExp,
)


def walk_scope(root: ast.AST):
    """Yield every node in `root`'s own scope, without entering nested scopes."""
    stack = list(ast.iter_child_nodes(root))
    while stack:
        node = stack.pop()
        yield node
        if isinstance(node, SCOPE_NODES):
            continue
        stack.extend(ast.iter_child_nodes(node))


def bound_names(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """Names that exist before the body runs: parameters and the function name."""
    args = fn.args
    names = {arg.arg for arg in (*args.posonlyargs, *args.args, *args.kwonlyargs)}
    if args.vararg:
        names.add(args.vararg.arg)
    if args.kwarg:
        names.add(args.kwarg.arg)
    names.add(fn.name)
    return names


def check_function(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> list[tuple[int, str]]:
    assigned: dict[str, int] = {}
    used: dict[str, int] = {}
    skip = bound_names(fn)

    def record(table: dict[str, int], name: str, lineno: int) -> None:
        # Earliest occurrence wins: the traversal order is not source order.
        if name not in table or lineno < table[name]:
            table[name] = lineno

    for node in walk_scope(fn):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                record(assigned, node.id, node.lineno)
            elif isinstance(node.ctx, ast.Load):
                record(used, node.id, node.lineno)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            # The definition binds its name in this scope even though its body
            # is a scope of its own.
            record(assigned, node.name, node.lineno)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            record(assigned, node.name, node.lineno)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                record(assigned, bound, node.lineno)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            # Rebound elsewhere; this scope cannot reason about the order.
            skip.update(node.names)

    problems = []
    for name, first_use in sorted(used.items(), key=lambda item: item[1]):
        if name in skip or name not in assigned:
            continue
        if assigned[name] > first_use:
            problems.append((
                first_use,
                f"{name!r} used on line {first_use} but first assigned on line {assigned[name]}",
            ))
    return problems


def check_source(source: str, filename: str) -> list[str]:
    tree = ast.parse(source, filename=filename)
    messages = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for line, message in check_function(node):
            messages.append(f"{filename}:{line}: in {node.name}(): {message}")
    return messages


def selftest() -> int:
    cases: list[tuple[str, int, str]] = [
        # (source, expected problem count, description)
        ("def f():\n    return total\n    total = 1\n", 1, "plain use before assign"),
        ("def f(items):\n    return [option for option in items]\n", 0, "list comprehension"),
        ("def f(rows):\n    return {key: value for key, value in rows}\n", 0, "dict comprehension"),
        ("def f(items):\n    return {x for x in items}\n", 0, "set comprehension"),
        ("def f(items):\n    return sum(n for n in items)\n", 0, "generator expression"),
        ("def f(items):\n    return [b for a in items for b in a]\n", 0, "nested comprehension"),
        ("def f():\n    def g():\n        return later\n    later = 1\n    return g\n", 0, "nested function scope"),
        ("def f(items):\n    return sorted(items, key=lambda entry: entry.name)\n", 0, "lambda"),
        ("def f():\n    try:\n        pass\n    except ValueError as exc:\n        return exc\n", 0, "except binding"),
        ("def f():\n    import json\n    return json.dumps({})\n", 0, "import binding"),
        ("def f():\n    value = compute()\n    return value\n", 0, "assign then use"),
        ("def f():\n    global counter\n    counter += 1\n", 0, "global declaration"),
        ("def f(n):\n    for i in range(n):\n        print(i)\n", 0, "loop target"),
        ("def f():\n    with open('x') as handle:\n        return handle.read()\n", 0, "with binding"),
        ("class C:\n    def m(self):\n        return self.x\n", 0, "method"),
    ]
    failures = 0
    for source, expected, label in cases:
        got = check_source(source, "<selftest>")
        if len(got) != expected:
            failures += 1
            print(f"selftest FAILED [{label}]: expected {expected}, got {len(got)}: {got}", file=sys.stderr)
    if failures:
        return 1
    print(f"check_use_before_assign selftest: ok ({len(cases)} cases)")
    return 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    paths = argv or ["benchmark_runner.py", "quality_eval.py"]
    failures = 0
    for path in paths:
        for message in check_source(Path(path).read_text(encoding="utf-8"), path):
            print(message, file=sys.stderr)
            failures += 1
    if failures:
        print(f"{failures} use-before-assignment problem(s)", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
