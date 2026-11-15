# CodeScout: Production Deployment Guide

This guide walks through deploying CodeScout on an **Oracle Cloud Always Free Ampere A1 (ARM64)** VM with automatic HTTPS via DuckDNS and Caddy.

---

## 1. Oracle Cloud VM Provisioning

### 1.1 Create the Compute Instance
1. In the Oracle Cloud Console, navigate to **Compute &rarr; Instances &rarr; Create Instance**.
2. **Placement**: Select an availability domain where Always Free Ampere resources are available.
3. **Image and Shape**:
   - **Image**: Canonical Ubuntu 22.04 LTS or 24.04 LTS (`aarch64` / ARM64).
   - **Shape**: `VM.Standard.A1.Flex` (Ampere).
   - **Configuration**:
     - OCPUs: 2 to 4 (Always Free tier provides up to 4 OCPUs)
     - Memory: 12 GB to 24 GB RAM (Always Free tier provides up to 24 GB)
4. **Networking**:
   - Assign a public IPv4 address.
5. **SSH Keys**:
   - Upload your public SSH key (`id_ed25519.pub` or `id_rsa.pub`).
6. Click **Create** and wait for the instance state to become `RUNNING`.

---

## 2. Reserve a Static Public IP

To ensure the public IP address does not change when the VM restarts:
1. In the Oracle Console, go to **Networking &rarr; Virtual Cloud Networks &rarr; [Your VCN] &rarr; IP Management &rarr; Reserved Public IPs**.
2. Click **Reserve Public IP Address**, name it `codescout-ip`, and select your compartment.
3. Once reserved, click the actions menu (&ctdot;) on the reserved IP &rarr; **Attach**.
4. Select your CodeScout VM's primary VNIC and confirm attachment.

---

## 3. Network Security & Firewall (Dual-Layer)

> [!IMPORTANT]
> Oracle Cloud has two independent firewall layers: the **VCN Security List** (cloud network layer) and **Host iptables** (inside Ubuntu). Both must be configured to allow HTTP (80) and HTTPS (443).

### 3.1 Layer 1: Oracle VCN Security List (Cloud Layer)
1. Go to **Networking &rarr; Virtual Cloud Networks &rarr; [Your VCN] &rarr; Security Lists &rarr; Default Security List**.
2. Click **Add Ingress Rules**:
   - **Source CIDR**: `0.0.0.0/0`
   - **IP Protocol**: `TCP`
   - **Destination Port Range**: `80,443`
   - **Description**: `Allow HTTP and HTTPS for Caddy reverse proxy`
3. Verify that port `22` is also open for SSH.

### 3.2 Layer 2: Host Firewall (Ubuntu iptables)
Oracle Cloud Ubuntu images include strict default iptables rules that reject incoming traffic before reaching standard user chains. Our automated setup script inserts rules at the top of the `INPUT` chain and persists them:

```bash
# Handled automatically by setup_vm.sh, or manually run:
sudo iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 22 -j ACCEPT
sudo netfilter-persistent save
```

---

## 4. DuckDNS Domain Setup

1. Sign in to [DuckDNS.org](https://www.duckdns.org) with your GitHub account.
2. Under **Domains**, choose a subdomain (e.g., `codescout`, resulting in `codescout.duckdns.org`).
3. In the **current ip** field, enter your reserved Oracle Cloud public IP.
4. Click **update ip**.
5. Note your **DuckDNS Token** from the top of the DuckDNS dashboard.

---

## 5. Automated VM Provisioning

SSH into your Oracle VM:

```bash
ssh ubuntu@<YOUR_RESERVED_IP>
```

Clone CodeScout and run the setup script:

```bash
sudo git clone https://github.com/Rahul1907/code-scout.git /opt/code-scout
cd /opt/code-scout
sudo bash infra/scripts/setup_vm.sh
```

The script will:
- Update all system packages.
- Install Docker Engine and the Docker Compose plugin (ARM64).
- Configure iptables for ports `80` and `443` and persist them with `netfilter-persistent`.
- Add the `ubuntu` user to the `docker` group.
- Create `/opt/code-scout/secrets` and `/opt/code-scout/data/repos`.
- Register the DuckDNS cron updater (`duckdns_update.sh`) to run every 5 minutes.

---

## 6. DuckDNS Safety Net Cron Script

Verify that `/opt/code-scout/infra/scripts/duckdns_update.sh` is configured:

```bash
# Test manual update
/opt/code-scout/infra/scripts/duckdns_update.sh codescout <YOUR_DUCKDNS_TOKEN>

# Verify log
cat /var/log/duckdns.log
```

The script will keep DuckDNS updated with your VM's public IP automatically.

---

## 7. Verification Checklist (Acceptance Criteria)

- [x] Oracle ARM VM active with reserved public IP.
- [x] VCN Ingress Rules allow TCP ports `80` and `443`.
- [x] Host iptables allows TCP ports `80` and `443` and persists after reboot.
- [x] DuckDNS domain resolves to the VM's public IP (`dig +short <DOMAIN>.duckdns.org`).
- [x] Ports 80 and 443 are open and reachable from the internet.
