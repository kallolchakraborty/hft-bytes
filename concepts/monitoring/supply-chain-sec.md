---
type: reference
title: "Supply Chain SEC"
description: "Dependency vetting: maintain a full dependency graph (direct + transitive). Reproducible builds: same source + same toolchain = same binary hash;"
tags: ["regulation"]
difficulty: intermediate
timestamp: "2026-06-27T03:06:09.449Z"
phase: 14
phaseName: "Monitoring & Security"
category: "Phase 14 - Monitoring & Security"
subcategory: "monitoring"
language: "cpp"
artifact-id: "ZHFT_SUPPLY_CHAIN_SEC"
---
## Key Learning Points

- Dependency vetting: maintain a full dependency graph (direct + transitive)
- Reproducible builds: same source + same toolchain = same binary hash;
- SBOM generation: CycloneDX or SPDX format; must include dependency
- Signed commits (GPG/SSH) prevent tampered dependency injection
- Dependency pinning: lockfiles (conan.lock, vcpkg.json, Cargo.lock) ensure

## Source Code

```cpp
#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

// ---------------------------------------------------------------------------
// Dependency graph representation.
// ---------------------------------------------------------------------------
// Each node is a package: name, version, purl (Package URL), and its own
// dependencies.
// ---------------------------------------------------------------------------
struct Dependency {
  std::string name;           // e.g., "fmt"
  std::string version;        // e.g., "10.1.1"
  std::string purl;           // e.g., "pkg:conan/fmt@10.1.1"
  std::string license;        // SPDX: "MIT"
  std::string sha256;         // Source tarball hash
  std::vector<Dependency *> deps; // Edges to children
};

class DependencyGraph {
  std::vector<Dependency> nodes_;

public:
  Dependency *add_or_get(const std::string &name, const std::string &version) {
    for (auto &n : nodes_) {
      if (n.name == name && n.version == version) return &n;
    }
    nodes_.push_back({.name = name, .version = version});
    return &nodes_.back();
  }

  void add_edge(Dependency *parent, Dependency *child) {
    if (parent && child) parent->deps.push_back(child);
  }

  // BFS traversal for scanning — visit every unique package once.
  void traverse(const Dependency *root,
                std::function<void(const Dependency &)> visitor) const {
    std::set<const Dependency *> visited;
    std::vector<const Dependency *> queue;
    if (root) queue.push_back(root);
    while (!queue.empty()) {
      auto *n = queue.back(); queue.pop_back();
      if (!visited.insert(n).second) continue;
      visitor(*n);
      for (auto *d : n->deps) queue.push_back(d);
    }
  }
};

// ---------------------------------------------------------------------------
// SBOM generator — produces CycloneDX 1.5 JSON.
// ---------------------------------------------------------------------------
class SbomGenerator {
  DependencyGraph &graph_;

public:
  explicit SbomGenerator(DependencyGraph &g) : graph_(g) {}

  std::string generate_cyclonedx(const Dependency &root) {
    // Build a flat list of all dependencies with BFS.
    std::ostringstream out;
    out << R"({"bomFormat":"CycloneDX","specVersion":"1.5","version":1,"components":[)";

    bool first = true;
    int  idx   = 0;
    std::map<const Dependency *, int> index_map;

    graph_.traverse(&root, [&](const Dependency &dep) {
      if (!first) out << ",";
      first = false;
      index_map[&dep] = idx++;
      out << R"({"type":"library","name":")" << dep.name
          << R"(","version":")" << dep.version
          << R"(","purl":")" << dep.purl
          << R"(","licenses":[{"license":{"id":")" << dep.license << R"("}}])"
          << R"(,"hashes":[{"alg":"SHA-256","content":")" << dep.sha256 << R"("}]})";
    });

    out << R"(],"dependencies":[)";
    first = true;
    graph_.traverse(&root, [&](const Dependency &dep) {
      if (!first) out << ",";
      first = false;
      auto it = index_map.find(&dep);
      out << R"({"ref":")" << dep.purl << R"(","dependsOn":[)";
      bool inner_first = true;
      for (auto *child : dep.deps) {
        if (!inner_first) out << ",";
        inner_first = false;
        out << R"(")" << child->purl << R"(")";
      }
      out << R"(]})";
    });

    out << R"(]})";
    return out.str();
  }
};

// ---------------------------------------------------------------------------
// Build reproducibility checker.
// ---------------------------------------------------------------------------
// Compares the SHA-256 of the current build artifact against a previously
// recorded golden hash. Uses pinned toolchain (Conan lockfile + fixed
// compiler version) to ensure identical output.
// ---------------------------------------------------------------------------
class BuildReproducibilityChecker {
  std::filesystem::path built_artifact_;

public:
  struct Result {
    bool   reproducible;
    std::string actual_hash;
    std::string expected_hash;
    std::string mismatch_reason; // e.g., "toolchain mismatch", "timestamp diff"
  };

  Result check(const std::filesystem::path &golden_hash_file) {
    Result res;

    // Compute SHA-256 of built artifact.
    res.actual_hash = sha256_file(built_artifact_);

    // Read expected hash.
    std::ifstream f(golden_hash_file);
    std::getline(f, res.expected_hash);

    // Normalize: strip whitespace.
    res.actual_hash.erase(res.actual_hash.find_last_not_of(" \n\r\t") + 1);
    res.expected_hash.erase(res.expected_hash.find_last_not_of(" \n\r\t") + 1);

    res.reproducible = (res.actual_hash == res.expected_hash);
    if (!res.reproducible) {
      res.mismatch_reason = "Hash mismatch — toolchain or source drift";
    }
    return res;
  }

private:
  static std::string sha256_file(const std::filesystem::path &p) {
    // In production: use EVP_Digest from OpenSSL or CC_SHA256 from Common Crypto.
    // Returns hex-encoded hash string.
    return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // Placeholder.
  }
};

// ---------------------------------------------------------------------------
// Vulnerability scanning integration.
// ---------------------------------------------------------------------------
// Parses the dependency graph and checks each PURL against OSV (Open Source
// Vulnerability) API. In CI, this would be cached to avoid rate limiting.
// ---------------------------------------------------------------------------
class VulnerabilityScanner {
public:
  struct Vuln {
    std::string id;       // CVE-2024-XXXXX
    std::string package;
    std::string severity; // CRITICAL / HIGH / MEDIUM / LOW
    std::string fix_version;
  };

  std::vector<Vuln> scan(const Dependency &root, DependencyGraph &graph) {
    std::vector<Vuln> findings;
    graph.traverse(&root, [&](const Dependency &dep) {
      // In production: HTTP GET https://api.osv.dev/v1/query with dep.purl.
      // Parse response JSON and populate findings.
    });
    return findings;
  }
};
```
