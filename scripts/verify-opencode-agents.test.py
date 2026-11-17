#!/usr/bin/env python3
"""Regression tests for the OpenCode agent registry verifier's path boundary."""
from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("verify-opencode-agents.py")
SPEC = importlib.util.spec_from_file_location("verify_opencode_agents", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("No se pudo cargar verify-opencode-agents.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AgentPermissionContractTests(unittest.TestCase):
    def test_permission_frontmatter_parser_preserves_action_resource_effect(self):
        lines = [
            "description: Test agent",
            "mode: all",
            "permissions:",
            "  - action: edit",
            "    resource: \"*\"",
            "    effect: deny",
            "  - action: subagent",
            "    resource: tester",
            "    effect: allow"
        ]
        self.assertEqual(
            MODULE.parse_permission_rules(lines),
            [("edit", "*", "deny"), ("subagent", "tester", "allow")]
        )

    def test_permission_rules_use_last_matching_rule(self):
        rules = [
            ("edit", "*", "deny"),
            ("edit", "src/**", "allow"),
            ("shell", "*", "ask"),
            ("shell", "git push *", "deny")
        ]
        self.assertEqual(MODULE.effective_agent_permission(rules, "edit", "src/Main.java"), "allow")
        self.assertEqual(MODULE.effective_agent_permission(rules, "edit", "config/app.yml"), "deny")
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "git push origin main"), "deny")
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "mvn test"), "ask")

    def test_shell_rule_with_trailing_space_wildcard_matches_bare_command(self):
        rules = [("shell", "mvn -B test *", "allow")]
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "mvn -B test"), "allow")
        self.assertEqual(MODULE.effective_agent_permission(rules, "shell", "mvn -B test -q"), "allow")

    def test_build_is_read_only_and_can_delegate_only_to_named_specialists(self):
        lines = [
            "permissions:",
            "  - action: edit", "    resource: \"*\"", "    effect: deny",
            "  - action: shell", "    resource: \"*\"", "    effect: deny",
            "  - action: subagent", "    resource: architect", "    effect: allow",
            "  - action: subagent", "    resource: implementer", "    effect: allow",
            "  - action: subagent", "    resource: reviewer", "    effect: allow",
            "  - action: subagent", "    resource: tester", "    effect: allow",
            "  - action: subagent", "    resource: cloud-arbiter", "    effect: allow",
            "  - action: subagent", "    resource: reverse", "    effect: allow"
        ]
        missing = MODULE.required_agent_permission_rules("build") - set(MODULE.parse_permission_rules(lines))
        self.assertEqual(missing, set())

    def test_read_only_agents_have_hard_deny_for_edit_and_shell(self):
        required = {("edit", "*", "deny"), ("shell", "*", "deny")}
        for agent in ("architect", "cloud-arbiter", "reviewer", "reverse"):
            with self.subTest(agent=agent):
                self.assertTrue(required.issubset(MODULE.required_agent_permission_rules(agent)))

    def test_tester_cannot_edit_but_shell_requires_approval_by_default(self):
        self.assertEqual(
            MODULE.required_agent_permission_rules("tester"),
            {("edit", "*", "deny"), ("shell", "*", "ask")}
        )

    def test_implementer_retains_explicit_destructive_command_denials(self):
        rules = MODULE.required_agent_permission_rules("implementer")
        self.assertIn(("shell", "git push *", "deny"), rules)
        self.assertIn(("shell", "sudo *", "deny"), rules)
        self.assertIn(("shell", "rm -rf *", "deny"), rules)


class SymlinkBoundaryTests(unittest.TestCase):
    def test_regular_project_paths_are_not_misclassified_as_symlinks(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-") as temp:
            root = Path(temp)
            agent = root / ".opencode" / "agents" / "reviewer.md"
            agent.parent.mkdir(parents=True)
            agent.write_text("---\nmode: all\n---\n", encoding="utf-8")
            self.assertFalse(MODULE.has_symlink_component(root, agent))

    def test_symlinked_agent_file_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-link-") as temp, \
             tempfile.TemporaryDirectory(prefix="factory-verifier-outside-") as outside:
            root = Path(temp)
            external = Path(outside) / "reviewer.md"
            external.write_text("external", encoding="utf-8")
            agent_dir = root / ".opencode" / "agents"
            agent_dir.mkdir(parents=True)
            (agent_dir / "reviewer.md").symlink_to(external)
            self.assertTrue(MODULE.has_symlink_component(root, agent_dir / "reviewer.md"))

    def test_symlinked_parent_directory_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-parent-") as temp, \
             tempfile.TemporaryDirectory(prefix="factory-verifier-outside-parent-") as outside:
            root = Path(temp)
            external_agents = Path(outside) / "agents"
            external_agents.mkdir()
            (external_agents / "reviewer.md").write_text("external", encoding="utf-8")
            (root / ".opencode").symlink_to(Path(outside), target_is_directory=True)
            self.assertTrue(MODULE.has_symlink_component(root, root / ".opencode" / "agents" / "reviewer.md"))

    def test_path_outside_project_fails_closed(self):
        with tempfile.TemporaryDirectory(prefix="factory-verifier-root-") as temp, \
             tempfile.TemporaryDirectory(prefix="factory-verifier-outside-") as outside:
            self.assertTrue(MODULE.has_symlink_component(Path(temp), Path(outside) / "reviewer.md"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
