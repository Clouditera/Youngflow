"""Group features into attack surface clusters."""

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def _get_last_chain_function(card: dict[str, Any]) -> str | None:
    """Get the function name of the last step in processing_chain."""
    chain = card.get("data_flow", {}).get("processing_chain", [])
    if not chain:
        return None
    last = chain[-1]
    return last.get("function") or None


def _get_http_endpoints(card: dict[str, Any]) -> set[str]:
    """Extract HTTP endpoint paths from entry_points."""
    endpoints = set()
    for ep in card.get("entry_points", []):
        if ep.get("type", "").lower() == "http" and ep.get("path"):
            endpoints.add(ep["path"])
    return endpoints


def _has_auth_gap(card: dict[str, Any]) -> bool:
    """Check if card has auth_required=false on HTTP entries."""
    sec = card.get("security", {})
    if sec.get("auth_required") is False:
        return True
    return any(ep.get("type", "").lower() == "http" and ep.get("auth_required") is False for ep in card.get("entry_points", []))


def _is_context_candidate(card: dict[str, Any]) -> bool:
    """Rule 4: Check if card should be context (not primary target)."""
    perspective = card.get("perspective", "")
    perspectives = card.get("perspectives", [])
    risk = card.get("risk_level", "").lower()
    name = card.get("name", "").lower()

    is_support_perspective = perspective in ("security-mechanism", "error-logging") or "security-mechanism" in perspectives or "error-logging" in perspectives

    # Condition A: support perspective + low risk
    if is_support_perspective and risk == "low":
        return True

    # Condition B: name suggests protective/framework + no HTTP entry
    protection_keywords = ("protection", "prevention", "framework")
    if any(kw in name for kw in protection_keywords):
        has_http = any(ep.get("type", "").lower() in ("http", "grpc") for ep in card.get("entry_points", []))
        if not has_http:
            return True

    return False


def _extract_interaction_type(card: dict[str, Any]) -> str | None:
    """Infer external interaction target type from card name/description."""
    name = card.get("name", "").lower()
    desc = card.get("description", "").lower()
    text = name + " " + desc

    type_map = [
        (r"s3|gcs|azure.*blob|cloud.*storage|bucket", "cloud-storage"),
        (r"opensearch|elasticsearch|solr", "search-engine"),
        (r"kafka|rabbitmq|sqs|message.*queue", "message-queue"),
        (r"database|mysql|postgres|jdbc|sql", "database"),
        (r"http.*fetch|url.*fetch|ssrf", "url-fetch"),
        (r"command|exec|process|cmd", "command-execution"),
        (r"file.*system|filesystem|path.*traversal", "filesystem"),
    ]
    for pattern, itype in type_map:
        if re.search(pattern, text):
            return itype
    return None


def _find_related_groups(
    card: dict[str, Any],
    groups: dict[str, dict[str, Any]],
    cards_by_id: dict[str, dict[str, Any]],
) -> str | None:
    """Find a group this context card relates to via related_features or code overlap."""
    # Check related_features
    for rel_id in card.get("related_features", []):
        for gid, group in groups.items():
            if rel_id in group["feature_ids"]:
                return gid

    # Check processing_chain code overlap with group's shared_code_paths
    chain = card.get("data_flow", {}).get("processing_chain", [])
    for step in chain:
        step_file = step.get("file", "")
        step_func = step.get("function", "")
        if not step_file:
            continue
        for gid, group in groups.items():
            for scp in group.get("shared_code_paths", []):
                if scp["file"].endswith(step_file) or step_file.endswith(scp["file"]):
                    if step_func in scp.get("functions", []):
                        return gid

    return None


def _normalize_risk_type(raw: str) -> str:
    """Normalize risk_type to canonical underscore form for matching.

    Feature cards may use hyphens (path-traversal), underscores (path_traversal),
    or spaces. Normalize all to underscores for consistent matching against
    _HIGH_SEVERITY_VULN_TYPES and other internal sets.
    """
    return raw.lower().replace("-", "_").replace(" ", "_")


def _match_high_severity(risk_type: str) -> str | None:
    """Match a normalized risk_type against high-severity types using prefix matching.

    Enumerators may produce qualified risk_types like "path_traversal_in_contents_api"
    or "ssrf_via_repo_migration". These should match the canonical type ("path_traversal",
    "ssrf") for attack surface grouping.

    Returns the matched canonical type, or None if no match.
    """
    if risk_type in _HIGH_SEVERITY_VULN_TYPES:
        return risk_type
    for canonical in _HIGH_SEVERITY_VULN_TYPES:
        if risk_type.startswith(canonical + "_"):
            return canonical
    return None


def _slugify(name: str) -> str:
    """Convert group name to a filesystem-safe slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower())
    slug = slug.strip("-")[:50]
    if not slug:
        match = re.search(r"[（(]([A-Za-z][A-Za-z0-9 -]+)[)）]", name)
        if match:
            slug = re.sub(r"[^a-z0-9]+", "-", match.group(1).lower()).strip("-")[:50]
    return slug or "unnamed"


# Attack surface labels for perspective-based residual grouping
_PERSPECTIVE_SURFACE = {
    "route-interface": ("HTTP 端点攻击面", "http-endpoint"),
    "data-processing": ("数据处理攻击面", "data-processing"),
    "external-interaction": ("外部交互攻击面", "external-interaction"),
    "security-mechanism": ("安全机制缺陷攻击面", "security-weakness"),
    "config-deployment": ("配置与部署攻击面", "config-deployment"),
    "error-logging": ("信息泄露攻击面", "information-disclosure"),
}

# High-severity vulnerability types that should form dedicated attack surface
# groups regardless of their source perspective. This ensures features from
# different perspectives (e.g. external-interaction, config-deployment) that
# share the same critical vulnerability type are analyzed together with the
# appropriate specialized security analyzer.
_HIGH_SEVERITY_VULN_TYPES = frozenset({
    "path_traversal",
    "rce",
    "code_injection",
    "command_injection",
    "ssrf",
    "deserialization",
    "sql_injection",
    "lfi",
    "symlink_attack",
    # Added: missing high-severity vuln types from OWASP/API7 classification
    "xxe",
    "auth_bypass",
    "idor",
    "open_redirect",
    "csrf",
    "file_upload",
    "ssti",
})

_VULN_TYPE_LABELS = {
    "path_traversal": ("Path Traversal 攻击面", "path-traversal"),
    "rce": ("远程代码执行攻击面", "rce"),
    "code_injection": ("代码注入攻击面", "code-injection"),
    "command_injection": ("命令注入攻击面", "command-injection"),
    "ssrf": ("SSRF 攻击面", "ssrf"),
    "deserialization": ("反序列化攻击面", "deserialization"),
    "sql_injection": ("SQL 注入攻击面", "sql-injection"),
    "lfi": ("本地文件包含攻击面", "lfi"),
    "symlink_attack": ("符号链接攻击面", "symlink-attack"),
    # Added: missing high-severity vuln type labels
    "xxe": ("XXE 攻击面", "xxe"),
    "auth_bypass": ("认证绕过攻击面", "auth-bypass"),
    "idor": ("IDOR 攻击面", "idor"),
    "open_redirect": ("开放重定向攻击面", "open-redirect"),
    "csrf": ("CSRF 攻击面", "csrf"),
    "file_upload": ("文件上传攻击面", "file-upload"),
    "ssti": ("模板注入攻击面", "ssti"),
}


def _cluster_by_related_features(
    unassigned: list[dict[str, Any]],
    assigned: set[str],
    cards_by_id: dict[str, dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    new_group_fn,
) -> None:
    """Rule 5: Cluster unassigned cards via mutual related_features links.

    Only clusters cards with **bidirectional** references (A refs B AND B refs A)
    to avoid runaway transitive chains. Uses union-find on mutual pairs.
    """
    id_list = [c.get("id", "") for c in unassigned if c.get("id", "") not in assigned]
    if not id_list:
        return

    id_set = set(id_list)

    # Build union-find
    parent: dict[str, str] = {i: i for i in id_list}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    # Only union cards with MUTUAL references (A->B and B->A)
    for cid in id_list:
        card = cards_by_id.get(cid, {})
        refs_a = set(card.get("related_features", []))
        for ref_id in refs_a:
            if ref_id not in id_set:
                continue
            ref_card = cards_by_id.get(ref_id, {})
            refs_b = set(ref_card.get("related_features", []))
            if cid in refs_b:
                union(cid, ref_id)

    # Collect clusters
    clusters: dict[str, list[str]] = {}
    for cid in id_list:
        root = find(cid)
        clusters.setdefault(root, []).append(cid)

    # Create groups for clusters with 2+ members
    for root, members in clusters.items():
        if len(members) < 2:
            continue
        # Already assigned members should be skipped
        members = [m for m in members if m not in assigned]
        if len(members) < 2:
            continue

        # Infer attack surface from the cluster
        surface_name, surface_slug = _infer_cluster_surface(
            members,
            cards_by_id,
        )
        new_group_fn(surface_name, surface_slug, sorted(members))


def _infer_cluster_surface(
    member_ids: list[str],
    cards_by_id: dict[str, dict[str, Any]],
) -> tuple[str, str]:
    """Infer a descriptive attack surface name from cluster members."""
    # Collect keywords from security.potential_risks
    risk_types: dict[str, int] = {}
    for mid in member_ids:
        c = cards_by_id.get(mid, {})
        for pr in c.get("security", {}).get("potential_risks", []):
            rt = _normalize_risk_type(pr.get("risk_type", ""))
            if rt:
                risk_types[rt] = risk_types.get(rt, 0) + 1

    # Use most common risk type
    if risk_types:
        top_risk = max(risk_types, key=risk_types.get)
        label = top_risk.replace("_", " ").title()
        slug = _slugify(top_risk)
        return f"{label} 攻击面", slug

    # Fallback: use perspective
    perspectives: dict[str, int] = {}
    for mid in member_ids:
        c = cards_by_id.get(mid, {})
        p = c.get("perspective", "")
        if p:
            perspectives[p] = perspectives.get(p, 0) + 1

    if perspectives:
        top_p = max(perspectives, key=perspectives.get)
        name, slug = _PERSPECTIVE_SURFACE.get(
            top_p,
            (f"{top_p} 攻击面", _slugify(top_p)),
        )
        return name, slug

    return "混合攻击面", "mixed"


def _group_by_perspective(
    primary_cards: list[dict[str, Any]],
    assigned: set[str],
    cards_by_id: dict[str, dict[str, Any]],
    new_group_fn,
) -> None:
    """Rule 6: Group remaining singletons by perspective."""
    perspective_buckets: dict[str, list[str]] = {}
    for card in primary_cards:
        cid = card.get("id", "")
        if cid in assigned:
            continue
        p = card.get("perspective", "")
        if not p:
            ps = card.get("perspectives", [])
            p = ps[0] if ps else "unknown"
        perspective_buckets.setdefault(p, []).append(cid)

    for perspective, ids in perspective_buckets.items():
        if len(ids) >= 2:
            name, slug = _PERSPECTIVE_SURFACE.get(
                perspective,
                (f"{perspective} 攻击面", _slugify(perspective)),
            )
            new_group_fn(name, slug, sorted(ids))
        elif len(ids) == 1:
            # True singleton — create its own group
            cid = ids[0]
            card = cards_by_id.get(cid, {})
            card_name = card.get("name", cid)
            # Use perspective-based English slug as attack_surface
            _, surface_slug = _PERSPECTIVE_SURFACE.get(
                perspective,
                (f"{perspective} 攻击面", _slugify(perspective)),
            )
            new_group_fn(card_name, surface_slug, [cid])


def group_features(
    cards: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Group cards into attack surface groups.

    Returns list of group dicts matching feature-group.schema.yaml.
    """
    cards_by_id = {c.get("id", ""): c for c in cards}

    # Separate context candidates from primary cards
    context_cards: list[dict[str, Any]] = []
    primary_cards: list[dict[str, Any]] = []
    for card in cards:
        if _is_context_candidate(card):
            context_cards.append(card)
        else:
            primary_cards.append(card)

    # Track which cards have been assigned to a group
    assigned: set[str] = set()
    groups: dict[str, dict[str, Any]] = {}
    group_counter = 0

    def _new_group(
        name: str,
        attack_surface: str,
        feature_ids: list[str],
        shared_paths: list[dict] | None = None,
    ) -> str:
        nonlocal group_counter
        group_counter += 1
        gid = f"group-{group_counter:03d}"
        groups[gid] = {
            "id": gid,
            "name": name,
            "attack_surface": attack_surface,
            "feature_ids": feature_ids,
            "context_feature_ids": [],
            "shared_code_paths": shared_paths or [],
            "total_risk_score": 0,
            "feature_cards_dir": "aggregated_features/",
        }
        assigned.update(feature_ids)
        return gid

    # Rule 0: Vulnerability-type-based grouping
    # Group features that share the same high-severity vulnerability type
    # regardless of their source perspective. This ensures e.g. a path_traversal
    # feature from external-interaction perspective is grouped with other
    # path_traversal features from config-deployment perspective.
    vuln_type_buckets: dict[str, list[str]] = {}
    for card in primary_cards:
        cid = card.get("id", "")
        if cid in assigned:
            continue
        for pr in card.get("security", {}).get("potential_risks", []):
            risk_type = _normalize_risk_type(pr.get("risk_type", ""))
            matched = _match_high_severity(risk_type)
            if matched:
                bucket = vuln_type_buckets.setdefault(matched, [])
                if cid not in bucket:
                    bucket.append(cid)

    for vtype, ids in vuln_type_buckets.items():
        if len(ids) >= 2:
            name, slug = _VULN_TYPE_LABELS.get(
                vtype,
                (f"{vtype.replace('_', ' ').title()} 攻击面", _slugify(vtype)),
            )
            _new_group(name, slug, sorted(ids))

    # Rule 1: Shared sink clustering
    sink_groups: dict[str, list[str]] = {}
    for card in primary_cards:
        cid = card.get("id", "")
        if cid in assigned:
            continue
        sink = _get_last_chain_function(card)
        if sink:
            sink_groups.setdefault(sink, []).append(cid)

    for sink_func, ids in sink_groups.items():
        if len(ids) >= 2:
            # Find shared file
            shared_file = ""
            for cid in ids:
                c = cards_by_id.get(cid, {})
                chain = c.get("data_flow", {}).get("processing_chain", [])
                if chain:
                    shared_file = chain[-1].get("file", "")
                    break
            short_func = sink_func.split(".")[-1] if "." in sink_func else sink_func
            surface = _slugify(short_func)
            shared = [{"file": shared_file, "functions": [sink_func]}] if shared_file else []
            _new_group(
                f"{short_func} 共享 sink 攻击面",
                surface,
                ids,
                shared,
            )

    # Rule 2: Same type external interaction
    ei_type_groups: dict[str, list[str]] = {}
    for card in primary_cards:
        cid = card.get("id", "")
        if cid in assigned:
            continue
        perspective = card.get("perspective", "")
        perspectives = card.get("perspectives", [])
        if perspective == "external-interaction" or "external-interaction" in perspectives:
            itype = _extract_interaction_type(card)
            if itype:
                ei_type_groups.setdefault(itype, []).append(cid)

    for itype, ids in ei_type_groups.items():
        if len(ids) >= 2:
            _new_group(
                f"{itype} 外部交互攻击面",
                itype,
                ids,
            )

    # Rule 3: Shared HTTP endpoint + auth gap
    endpoint_groups: dict[str, list[str]] = {}
    for card in primary_cards:
        cid = card.get("id", "")
        if cid in assigned:
            continue
        if not _has_auth_gap(card):
            continue
        for ep in _get_http_endpoints(card):
            # Normalize: strip path params
            base = re.sub(r"\{[^}]+\}", "*", ep)
            endpoint_groups.setdefault(base, []).append(cid)

    # Group cards sharing endpoints
    ep_merged: dict[str, set[str]] = {}
    for ep, ids in endpoint_groups.items():
        if len(ids) >= 2:
            key = frozenset(ids)
            existing = None
            for k, v in ep_merged.items():
                if v & set(ids):
                    existing = k
                    break
            if existing:
                ep_merged[existing] |= set(ids)
            else:
                ep_merged[ep] = set(ids)

    for ep, ids_set in ep_merged.items():
        unassigned = [i for i in ids_set if i not in assigned]
        if len(unassigned) >= 2:
            _new_group(
                "HTTP 端点认证缺失攻击面",
                "http-endpoint-no-auth",
                sorted(unassigned),
            )

    # Rule 4: Context features — attach to related groups
    unattached_context: list[dict[str, Any]] = []
    for card in context_cards:
        cid = card.get("id", "")
        related_gid = _find_related_groups(card, groups, cards_by_id)
        if related_gid:
            groups[related_gid]["context_feature_ids"].append(cid)
        else:
            unattached_context.append(card)

    # Rule 5: related_features transitive clustering
    # Unassigned cards that reference each other form clusters
    unassigned_primary = [c for c in primary_cards if c.get("id", "") not in assigned]
    _cluster_by_related_features(
        unassigned_primary,
        assigned,
        cards_by_id,
        groups,
        _new_group,
    )

    # Rule 6: Same-perspective residual grouping
    # Remaining singletons in the same perspective merge into one group
    # Include unattached context cards so they aren't lost
    all_remaining = primary_cards + unattached_context
    _group_by_perspective(
        all_remaining,
        assigned,
        cards_by_id,
        _new_group,
    )

    # Compute total_risk_score per group
    for gid, group in groups.items():
        total = 0
        for fid in group["feature_ids"]:
            c = cards_by_id.get(fid, {})
            total += c.get("composite_score", 0)
        group["total_risk_score"] = total

    # Build shared_code_paths for groups that don't have them yet
    for gid, group in groups.items():
        if group["shared_code_paths"]:
            continue
        # Collect all code paths from member cards, tracking risk level per file
        file_funcs: dict[str, set[str]] = {}
        file_risk: dict[str, str] = {}  # track highest risk_level per file
        for fid in group["feature_ids"]:
            c = cards_by_id.get(fid, {})
            card_risk = c.get("risk_level", "low").lower()
            for cl in c.get("code_locations", []):
                f = cl.get("file", "")
                if f:
                    file_funcs.setdefault(f, set())
                    if card_risk == "high" or (card_risk == "medium" and file_risk.get(f) != "high"):
                        file_risk[f] = card_risk
            for step in c.get("data_flow", {}).get("processing_chain", []):
                f = step.get("file", "")
                fn = step.get("function", "")
                if f and fn:
                    file_funcs.setdefault(f, set()).add(fn)
                    if card_risk == "high" or (card_risk == "medium" and file_risk.get(f) != "high"):
                        file_risk[f] = card_risk

        # Include files referenced by 2+ member cards,
        # OR files from high/medium-risk features (to avoid blind spots on
        # single-feature entry points like dedicated WebSocket handlers)
        if len(group["feature_ids"]) > 1:
            for f, funcs in file_funcs.items():
                count = 0
                for fid in group["feature_ids"]:
                    c = cards_by_id.get(fid, {})
                    all_files = set()
                    for cl in c.get("code_locations", []):
                        all_files.add(cl.get("file", ""))
                    for step in c.get("data_flow", {}).get("processing_chain", []):
                        all_files.add(step.get("file", ""))
                    if f in all_files:
                        count += 1
                is_high_risk = file_risk.get(f) in ("high", "medium")
                if (count >= 2 or is_high_risk) and funcs:
                    group["shared_code_paths"].append(
                        {
                            "file": f,
                            "functions": sorted(funcs),
                        }
                    )

    # Safety net: ensure every card is in at least one group
    all_grouped_ids: set[str] = set()
    for group in groups.values():
        all_grouped_ids.update(group["feature_ids"])
        all_grouped_ids.update(group["context_feature_ids"])
    all_card_ids = set(cards_by_id.keys())
    orphans = all_card_ids - all_grouped_ids
    if orphans:
        logger.warning(
            "Found %d orphaned features not in any group, creating fallback: %s",
            len(orphans),
            ", ".join(sorted(orphans)),
        )
        _new_group("未分组功能点", "orphaned", sorted(orphans))

    result = sorted(groups.values(), key=lambda g: g["total_risk_score"], reverse=True)

    # Re-number groups by final order
    for idx, group in enumerate(result, 1):
        group["id"] = f"group-{idx:03d}"

    logger.info(
        "Grouped %d primary cards + %d context cards into %d groups",
        len(primary_cards),
        len(context_cards),
        len(result),
    )
    return result
