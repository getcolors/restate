terraform {
  required_providers {
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.0" }
  }
}
provider "digitalocean" {}

# Discover the configured region's account default at plan/apply time. The UUID
# is deliberately neither configured nor persisted in colors.yml.
data "digitalocean_vpc" "default" {
  name = "default-ams3"
}

resource "digitalocean_droplet" "restate" {
  name     = "restate-fixture"
  region   = "ams3"
  size     = "s-8vcpu-16gb"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.default.id
  ssh_keys = ["58495393"]
  lifecycle { prevent_destroy = true }
}

resource "digitalocean_firewall" "restate" {
  name        = "restate-fixture-firewall"
  droplet_ids = [digitalocean_droplet.restate.id]
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  lifecycle { prevent_destroy = true }
}

output "params" {
  value = { ip = digitalocean_droplet.restate.ipv4_address, user = "root", sudoer = "root", name = "restate-fixture" }
}
