(ns io.github.getcolors.restate.tools-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [green.ansible :as ansible]
            [green.scaffold :as sc]
            [io.github.getcolors.restate.tools :as tools]
            [io.github.getcolors.restate.validate-test :refer [fixture keygen]]))

(deftest ansible-cfg-names-the-private-key-only-in-keygen-mode
  (let [render (fn [opts] (sc/render-template (tools/template "ansible" "ansible.cfg")
                                              (tools/ansible-data opts) tools/template-opts))]
    (is (str/includes? (render (assoc (keygen) :ssh-private-key-path "/k")) "private_key_file = /k"))
    (is (str/includes? (render (fixture)) "private_key_file = /home/build-placeholder/.ssh/operator-key"))))

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
      (is (= 1 (:green/exit r)))
      (is (= "compute node unavailable" (:green/err r))))))

(deftest delete-cleanup-targets-the-adopted-address
  ;; When the start step recovered the Droplet address from state, the
  ;; cleanup playbook runs against it, never the documentation fallback.
  (with-redefs [ansible/ansible-with-spec
                (fn [opts _ _] (assoc opts :green/exit 0 ::ran-against (:ip opts)))]
    (let [r (tools/ansible-step (fixture :green/event :delete :ip "203.0.113.7" :user "root"))]
      (is (= "203.0.113.7" (::ran-against r))))))
