---
type: reference
title: "RDMA & RoCE"
description: "Remote Direct Memory Access bypasses the kernel for ultra-low-latency data transfer. RoCE v2 encapsulates InfiniBand verbs over Ethernet. ibverbs API for one-sided reads/writes."
tags: ["rdma"]
timestamp: "2026-06-27T03:06:09.420Z"
phase: 4
phaseName: "System Programming & IPC"
category: "System Programming & IPC"
subcategory: "system-programming"
language: "cpp"
artifact-id: "ZHFT_RDMA_ROCE"
---
## Key Learning Points

- RDMA bypasses the kernel networking stack entirely: zero-copy, no context-switch, no syscall on data path
- Verbs API: ibv_open_device, ibv_alloc_pd, ibv_create_cq, ibv_create_qp, ibv_post_send/recv, ibv_poll_cq
- One-sided operations (READ/WRITE) access remote memory without remote CPU involvement; atomic operations (CAS/FAA) for distributed data structures
- Two-sided operations (SEND/RECV) involve both sides; lower latency than TCP but require remote CPU
- RoCE v2 runs over standard Ethernet fabric (UDP port 4791); requires PFC (Priority Flow Control) for lossless transport
- RoCE congestion control: DCQCN (Data Center Quantised Congestion Notification) for fabric fairness
- ibv_wr semantics: WR (Work Request) submitted via post_send/post_recv, completion polled from CQ
- Registration: ibv_reg_mr pins memory pages and creates memory region for DMA access

## Usage

```cpp
#include <infiniband/verbs.h>
#include <vector>

struct RdmaEndpoint {
    ibv_context*  ctx = nullptr;
    ibv_pd*       pd  = nullptr;
    ibv_cq*       cq  = nullptr;
    ibv_qp*       qp  = nullptr;
    ibv_mr*       mr  = nullptr;
    void*         buf = nullptr;
    size_t        buf_size = 1'000'000;

    bool init(const char* dev_name = "mlx5_0") {
        int dev_count = 0;
        ibv_device** dev_list = ibv_get_device_list(&dev_count);
        if (!dev_count) return false;

        ctx = ibv_open_device(dev_list[0]);
        pd  = ibv_alloc_pd(ctx);
        cq  = ibv_create_cq(ctx, 1024, nullptr, nullptr, 0);

        ibv_qp_init_attr qp_attr = {};
        qp_attr.send_cq = cq;
        qp_attr.recv_cq = cq;
        qp_attr.qp_type = IBV_QPT_RC;  // Reliable Connection
        qp_attr.cap.max_send_wr  = 128;
        qp_attr.cap.max_recv_wr  = 128;
        qp_attr.cap.max_send_sge = 1;
        qp_attr.cap.max_recv_sge = 1;
        qp = ibv_create_qp(pd, &qp_attr);

        buf = aligned_alloc(4096, buf_size);
        mr  = ibv_reg_mr(pd, buf, buf_size,
                         IBV_ACCESS_LOCAL_WRITE |
                         IBV_ACCESS_REMOTE_READ |
                         IBV_ACCESS_REMOTE_WRITE);
        return true;
    }

    // One-sided RDMA read (pulls data from remote memory)
    void rdmaRead(uint64_t remote_addr, uint32_t rkey, size_t len) {
        ibv_sge sge = { (uint64_t)buf, (uint32_t)len, mr->lkey };
        ibv_send_wr wr = {};
        wr.wr_id = 1;
        wr.opcode = IBV_WR_RDMA_READ;
        wr.num_sge = 1;
        wr.sg_list = &sge;
        wr.wr.rdma.remote_addr = remote_addr;
        wr.wr.rdma.rkey = rkey;

        ibv_send_wr* bad = nullptr;
        ibv_post_send(qp, &wr, &bad);
        // Poll CQ for completion
    }

    ~RdmaEndpoint() {
        if (qp)  ibv_destroy_qp(qp);
        if (cq)  ibv_destroy_cq(cq);
        if (mr)  ibv_dereg_mr(mr);
        if (pd)  ibv_dealloc_pd(pd);
        if (ctx) ibv_close_device(ctx);
        if (buf) free(buf);
    }
};
```

## Source Code

```cpp
// In HFT: RDMA used for synchronising order-book snapshots
// between primary and backup trading engines (< 5 us latency)
// QP (Queue Pair) setup requires connection establishment
// via TCP out-of-band exchange of QP numbers and keys
```
