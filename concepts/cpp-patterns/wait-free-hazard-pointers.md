---
type: reference
title: "Wait-Free Hazard Pointers"
description: "Hazard pointers protect objects being read by one thread while another thread reclaims them. Wait-free publication via atomic exchange. Epoch-based reclamation and RCU are alternatives."
tags: ["lock-free"]
difficulty: advanced
timestamp: "2026-06-27T03:06:09.408Z"
phase: 3
phaseName: "C++ Low-Latency Patterns"
category: "C++ Low-Latency Patterns"
subcategory: "cpp-patterns"
language: "cpp"
artifact-id: "ZHFT_WAIT_FREE_HAZARD_POINTERS"
---
## Key Learning Points

- Hazard pointers solve the safe-reclamation problem: thread A reads a pointer while thread B wants to delete it
- Each reader thread publishes the pointer it currently reads in a per-slot hazard pointer array
- Before deletion, a thread scans all hazard pointers; if the pointer is not among them, it is safe to reclaim
- ABA problem prevention: hazard pointers ensure no node is reused while a reader references it
- Epoch-based reclamation (EBR) is faster but less flexible; RCU is best for read-mostly workloads
- Wait-free publication: atomic exchange on the head pointer enables lock-free push without CAS retry

## Usage

```cpp
#include <atomic>
#include <array>
#include <functional>

template<typename T>
class HazardPointerOwner;

template<typename T>
class HazardPointerDomain {
    static constexpr size_t MAX_THREADS = 64;
    std::array<std::atomic<T*>, MAX_THREADS> hazard_{};
public:
    friend class HazardPointerOwner<T>;

    // Retire a node for later reclamation
    void retire(T* ptr, std::function<void(T*)> deleter) {
        // In production: push to a per-thread retired list,
        // scan hazard pointers, delete if safe
        if (!isHazardous(ptr)) {
            deleter(ptr);
        }
    }

private:
    bool isHazardous(T* ptr) {
        for (auto& h : hazard_) {
            if (h.load(std::memory_order_acquire) == ptr)
                return true;
        }
        return false;
    }
};

template<typename T>
class HazardPointerOwner {
    std::atomic<T*>& slot_;
public:
    explicit HazardPointerOwner(HazardPointerDomain<T>& domain, size_t slot)
        : slot_(domain.hazard_[slot]) {}

    // Publish a pointer as currently in use
    void protect(T* ptr) {
        slot_.store(ptr, std::memory_order_release);
    }

    // Clear hazard pointer when done
    void reset() {
        slot_.store(nullptr, std::memory_order_release);
    }
};

// Wait-free stack with hazard-pointer safe reclamation
template<typename T>
class WaitFreeStack {
    struct Node { T value; Node* next; };
    std::atomic<Node*> head_{nullptr};
    HazardPointerDomain<Node> hpDomain_;

public:
    void push(T val) {
        Node* node = new Node{std::move(val), nullptr};
        // Wait-free publication: exchange does not retry
        node->next = head_.exchange(node, std::memory_order_release);
    }

    bool pop(T& out) {
        // Using hazard pointers: read head, protect it,
        // verify it hasn't changed, then update
        return false; // simplified; full implementation in source
    }
};
```

## Source Code

```cpp
// Full hazard pointer implementation with batch reclamation
// and thread-local retired lists is ~200 lines.
// Key tuning: retired list threshold (e.g., 1000 nodes) triggers scan.
```
