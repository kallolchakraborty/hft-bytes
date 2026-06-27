---
type: reference
title: "Cloud & Hybrid Infrastructure for HFT"
description: "AWS Nitro for research K8s, GCP BigQuery for historical analysis, hybrid networking (Direct Connect → colo cross-connect), spot instances for burst backtesting, cloud security for exchange credentials, multi-region research clusters."
tags: ["testing"]
timestamp: "2026-06-27T04:00:00.000Z"
phase: 15
phaseName: "Testing & Production"
category: "Testing"
subcategory: "testing"
language: "yaml"
artifact-id: "ZHFT_CLOUD_HFT"
---
## Key Learning Points

- AWS Nitro for research: bare-metal EC2 instances (i3.metal, c5n.metal) used for large-scale backtesting; Nitro hypervisor adds no measurable latency overhead vs physical; K8s cluster via EKS for distributed backtest jobs; ephemeral NVMe scratch for temp data (up to 15 TB/instance)
- GCP BigQuery for tick data lake: serverless SQL engine on petabyte-scale tick datasets; partition by date + cluster by symbol; sub-second queries on months of tick data; cost ~$5/TB scanned; use streaming insert for real-time tick ingestion to BigQuery
- Hybrid networking (AWS Direct Connect → colo): Direct Connect (1/10/100 Gbps) connects AWS VPC to colo cage via cross-connect at Equinix/CoreSite; VPC subnets extended into colo via private VLAN; research data stays internal, no internet transit
- Spot instances for burst compute: AWS Spot (90% discount vs on-demand) for massively parallel backtests; handle interruptions with checkpointing to S3 (every 1000 simulations); Spot Fleet balanced across AZs and instance types
- Cloud security for exchange credentials: exchange FIX credentials (username, password, SenderCompID) encrypted with AWS KMS at rest; parameter store (AWS SSM) for per-trader API keys; Secrets Manager auto-rotates co-location switch credentials
- Data lake: S3 → Parquet partitioned by `(year, month, day, exchange)` → Glue/Athena for ad-hoc querying; Iceberg tables for ACID transactions on tick data; lifecycle policy: S3 Glacier after 90 days, Deep Archive after 1 year

## Usage

```yaml
# AWS Direct Connect — VPC to colo attachment
# Equinix Fabric → Direct Connect → Transit Gateway → VPC
# Colo router: BGP session with NAS (Nat. AS 64512)
# On-prem CIDR: 10.10.0.0/16 (colo network)
# VPC CIDR: 10.0.0.0/16 (research cluster)

# EKS backtesting job (spot instance)
apiVersion: batch/v1
kind: Job
metadata:
  name: backtest-20260627
spec:
  template:
    spec:
      priorityClassName: burst
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            preference:
              matchExpressions:
              - key: eks.amazonaws.com/capacityType
                operator: In
                values: [SPOT]
      containers:
      - name: backtest
        image: hft-research/backtest:latest
        resources:
          limits:
            memory: 256Gi
            cpu: 48
        volumeMounts:
        - name: scratch
          mountPath: /data
      volumes:
      - name: scratch
        emptyDir: {}  # NVMe ephemeral

# S3 data lake partitioning
# s3://hft-tick-lake/
#   year=2026/month=06/day=27/exchange=CME/
#     ESH7.parquet, NQH7.parquet, CLQ7.parquet
```

## Source Code

```python
# BigQuery schema for tick data lake
SCHEMA = [
    {"name": "symbol", "type": "STRING"},
    {"name": "exchange", "type": "STRING"},
    {"name": "ts_ns", "type": "TIMESTAMP"},
    {"name": "bid_px", "type": "FLOAT64"},
    {"name": "bid_sz", "type": "INT64"},
    {"name": "ask_px", "type": "FLOAT64"},
    {"name": "ask_sz", "type": "INT64"},
    {"name": "last_px", "type": "FLOAT64"},
    {"name": "last_sz", "type": "INT64"},
]

# Partition by DATE(ts_ns), cluster by symbol
# CREATE TABLE tick_data.cme_l2
# PARTITION BY DATE(ts_ns)
# CLUSTER BY symbol
# OPTIONS(description="CME Level-2 tick data")
```
