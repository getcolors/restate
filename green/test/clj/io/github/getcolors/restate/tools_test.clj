(ns io.github.getcolors.restate.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.ansible :as ansible]
            [green.scaffold :as sc]
            [io.github.getcolors.restate.tools :as tools]
            [io.github.getcolors.restate.validate-test :refer [fixture keygen]]))

(def template-file
  "src/resources/io/github/getcolors/restate/tools/infrastructure/digitalocean/main.tf")

(defn- render-infrastructure
  "The compute template for `opts`' provider, rendered as `build` would."
  [opts]
  (sc/render-template (tools/template (str "infrastructure." (:provider-compute opts)) "main.tf")
                      (tools/infrastructure-data opts)
                      tools/template-opts))

(deftest infrastructure-discovers-default-vpc
  (let [data (tools/infrastructure-data (fixture))]
    (is (= ["0.0.0.0/0" "::/0"] (tools/cidrs data :digitalocean-http-sources)))))

(deftest compute-keys-follow-the-selected-provider
  ;; Firewall sources are named after the provider, so a step reaching them
  ;; through a fixed prefix would silently render an empty list on any other
  ;; provider -- a firewall with no rules rather than an error.
  (is (str/includes? (:ssh-sources-hcl (tools/infrastructure-data (fixture))) "0.0.0.0/0"))
  (is (str/includes? (:http-sources-hcl (tools/infrastructure-data (fixture))) "0.0.0.0/0")))

(deftest infrastructure-data-carries-the-name-and-the-keypair-mode
  ;; One resolved name and one mode reach the template, so it never branches
  ;; on the provider or re-derives either.
  (let [data (tools/infrastructure-data (fixture))]
    (is (= "restate-fixture" (:compute-name data)))
    (is (false? (:ssh-keygen data))))
  (let [data (tools/infrastructure-data (keygen))]
    (is (= "restate-keygen-fixture" (:compute-name data)))
    (is (true? (:ssh-keygen data))))
  (is (true? (:ssh-keygen (tools/ansible-data (keygen)))))
  (is (false? (:ssh-keygen (tools/ansible-data (fixture))))))

(deftest the-template-lives-under-its-provider-directory
  ;; Providers are selected by directory (Compute Provider Standard §3); the
  ;; rendered target is still `<stage>/main.tf`.
  (let [[spec] (tools/infrastructure-specs (fixture))]
    (is (= :io.github.getcolors.restate.tools.infrastructure.digitalocean/main.tf (:template spec)))
    (is (str/ends-with? (str (:target spec)) "restate-infrastructure/main.tf"))))

(deftest templates-name-the-machine-from-one-resolved-value
  ;; Every label -- Droplet name, firewall name and params.name --
  ;; interpolates compute-name, never a provider key or the profile directly,
  ;; so an override and the fallback land everywhere at once.
  (let [template (slurp template-file)]
    (is (not (str/includes? template "<{ digitalocean-name }>")))
    (is (str/includes? template "name     = \"<{ compute-name }>\""))
    (is (str/includes? template "name        = \"<{ compute-name }>-firewall\""))
    (is (str/includes? template "name = \"<{ compute-name }>\""))
    (is (str/includes? template "provider = \"digitalocean\"")))
  (let [rendered (render-infrastructure (fixture :digitalocean-name "custom-label"))]
    (is (str/includes? rendered "name     = \"custom-label\""))
    (is (str/includes? rendered "name        = \"custom-label-firewall\""))
    (is (str/includes? rendered "name = \"custom-label\""))))

(deftest keygen-mode-declares-the-profile-named-key-and-opt-out-keeps-the-literal
  ;; SSH Keypair Standard §4.3: in keygen mode the template creates the
  ;; account key, named after the profile, and references it by attribute; in
  ;; opt-out mode it creates nothing and the historical literal survives.
  (let [rendered (render-infrastructure (assoc (keygen) :ssh-public-key-path "/home/build-placeholder/.ssh/restate-keygen-fixture.pub"))]
    (is (str/includes? rendered "resource \"digitalocean_ssh_key\" \"machine\""))
    (is (str/includes? rendered "name       = \"restate-keygen-fixture\""))
    (is (str/includes? rendered "ssh_keys = [digitalocean_ssh_key.machine.id]"))
    (is (str/includes? rendered "ssh_key_id = digitalocean_ssh_key.machine.id")))
  (let [rendered (render-infrastructure (fixture))]
    (is (not (str/includes? rendered "digitalocean_ssh_key")))
    (is (str/includes? rendered "ssh_keys = [\"58495393\"]"))
    (is (not (str/includes? rendered "ssh_key_id")))))

(deftest empty-http-sources-renders-no-public-http
  ;; An empty `digitalocean-http-sources` is allowed and means no public HTTP:
  ;; the 80/443 rules are a dynamic block over an empty list, because a
  ;; DigitalOcean rule with no source is an API error, not a closed port. SSH
  ;; stays.
  (let [rendered (render-infrastructure (fixture :digitalocean-http-sources []))]
    (is (str/includes? rendered "length([]) > 0 ? ["))
    (is (str/includes? rendered "source_addresses = []"))
    (is (str/includes? rendered "port_range       = \"22\""))
    (is (not (str/includes? rendered "port_range       = \"80\""))))
  (let [rendered (render-infrastructure (fixture))]
    (is (str/includes? rendered "length([\"0.0.0.0/0\", \"::/0\"]) > 0 ? ["))
    (is (str/includes? rendered "{ protocol = \"tcp\", port_range = \"443\" }"))
    (is (not (str/includes? rendered "udp\", port_range = \"443\"")) "TCP 80 and 443, and nothing else")))

(deftest ansible-cfg-names-the-private-key-only-in-keygen-mode
  (let [render (fn [opts] (sc/render-template (tools/template "ansible" "ansible.cfg")
                                              (tools/ansible-data opts) tools/template-opts))]
    (is (str/includes? (render (assoc (keygen) :ssh-private-key-path "/k")) "private_key_file = /k"))
    (is (not (str/includes? (render (fixture)) "private_key_file")))))

(deftest dns-is-apex-and-proxied
  (let [json (tools/dns-json (assoc (fixture) :ip "192.0.2.10"))]
    (is (str/includes? json "restate.example.com"))
    (is (str/includes? json "192.0.2.10"))
    (is (str/includes? json "proxied"))))

(deftest inventory-keeps-one-private-target
  (let [inventory (tools/inventory (assoc (fixture) :ip "192.0.2.10"))]
    (is (str/includes? inventory "192.0.2.10"))
    (is (str/includes? inventory "restate-fixture"))))

(deftest delete-cleanup-skips-when-state-has-no-compute
  ;; With the Droplet already gone the inventory would render 192.0.2.10;
  ;; there is no host to reach, so the step must not run the playbook and the
  ;; teardown must continue past it.
  (with-redefs [ansible/ansible-with-spec
                (fn [& _] (throw (ex-info "playbook must not run" {})))]
    (let [r (tools/ansible-step (fixture :green/event :delete))]
      (is (= 0 (:green/exit r)))
      (is (= :skipped-no-compute (:restate/cleanup r))))))

(deftest delete-cleanup-targets-the-adopted-address
  ;; When the start step recovered the Droplet address from state, the
  ;; cleanup playbook runs against it, never the documentation fallback.
  (with-redefs [ansible/ansible-with-spec
                (fn [opts _ _] (assoc opts :green/exit 0 ::ran-against (:ip opts)))]
    (let [r (tools/ansible-step (fixture :green/event :delete :ip "203.0.113.7"))]
      (is (= "203.0.113.7" (::ran-against r))))))

(deftest a-missing-compute-output-fails-loudly
  ;; The documentation address belongs to build and dry-run. Merging it into a
  ;; real converge would point Ansible at TEST-NET instead of failing. ONCE's
  ;; `resolved-compute`, wired by `infrastructure-step`.
  (is (= "1.2.3.4" (:ip (tools/resolved-compute {} {:ip "192.0.2.10"} {:ip "1.2.3.4"}))))
  (is (= 1 (:green/exit (tools/resolved-compute {} {:ip "192.0.2.10"} nil))))
  (is (str/includes? (:green/err (tools/resolved-compute {} {:ip "192.0.2.10"} {}))
                     "compute produced no ip output; refusing to converge against the documentation address"))
  (is (nil? (:green/exit (tools/resolved-compute {} {:ip "192.0.2.10"} {:ip "5.6.7.8"})))))

(deftest fallback-params-carry-the-provider-and-the-resolved-name
  (is (= {:provider "digitalocean" :ip "192.0.2.10" :user "root" :sudoer "root"
          :name "restate-keygen-fixture"}
         (tools/fallback-params (keygen)))))

(deftest the-acceptance-reboot-threads-the-identity-args
  ;; In keygen mode nothing guarantees an agent holds the key, so the reboot
  ;; ssh must select it explicitly.
  (let [src (slurp "src/clj/io/github/getcolors/restate/tools.clj")]
    (is (str/includes? src "(into (ssh/identity-args opts))"))))
