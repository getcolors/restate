(ns io.github.getcolors.restate.tools
  (:require [cheshire.core :as json]
            [green.ansible :as ansible]
            [green.cli :as green-cli]
            [green.process :as process]
            [green.scaffold :as sc]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.restate.ssh :as ssh]
            [io.github.getcolors.restate.ssh-config :as ssh-config]
            [io.github.getcolors.restate.validate :as validate]))

(def infrastructure-tool "restate-infrastructure")
(def dns-tool "restate-dns")
(def ansible-tool "restate-ansible")
(def ansible-local-tool "restate-ansible-local")
(def root "io.github.getcolors.restate.tools")
(def template-opts sc/preserve-jinja-delimiters)
(defn tool-dir [opts tool] (green-cli/stage-dir opts tool {:default-profile "restate"}))
(defn template [path file] (keyword (str root "." path) file))
(defn spec [source target data] {:template source :target target :data data :opts template-opts})
(defn raw-spec [target content] (sc/content-spec target content))
(def cidrs
  "The source lists as validate parses them, so the template and the
  validator can never disagree about what an entry is. ONCE's."
  validate/cidrs)
(defn credential-env [opts & slots]
  (not-empty
   (into {} (keep (fn [[k env-var]]
                    (when-let [v (not-empty (str (get opts k)))] [env-var v])))
         (apply merge (map #(validate/tofu-env opts %) (conj (vec slots) :provider-backend))))))
(defn backend-credential-env [opts] (credential-env opts))

(def fallback-params
  "What `build` and `--dry-run` render in place of a compute output: the
  documentation address, shaped like the selected provider's real `params` so
  every later stage sees the same keys either way. ONCE's."
  compute/fallback-params)

(def resolved-compute
  "Refuse to hand 192.0.2.10 to Ansible on a real converge whose compute
  output carries no `ip`. ONCE's; `infrastructure-step` is what wires it."
  compute/resolved-compute)

(def compute-key
  "`:<provider>-<suffix>`, the selected provider's key. ONCE's, via validate."
  validate/compute-key)

(def compute-name
  "The machine's name: `digitalocean-name` when present, else the profile.
  ONCE's, via validate; the template derives every label from it."
  validate/compute-name)

(defn infrastructure-data
  "Template values for the compute stage. The name, the keypair mode and the
  source lists are resolved here once, so the template interpolates values and
  never branches on which provider it belongs to."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :compute-name (compute-name opts)
         :ssh-sources-hcl (tofu/hcl-list (cidrs opts (compute-key opts "ssh-sources")))
         :http-sources-hcl (tofu/hcl-list (cidrs opts (compute-key opts "http-sources")))))
(defn infrastructure-specs
  "Providers are selected by template directory, not by conditionals inside
  one file: `tools/infrastructure/<provider>/main.tf` renders to the same
  `main.tf` whichever provider produced it."
  [opts]
  (let [dir (tool-dir opts infrastructure-tool)]
    [(spec (template (str "infrastructure." (:provider-compute opts)) "main.tf")
           (str dir "/main.tf") (infrastructure-data opts))]))
(defn infrastructure-step [opts]
  (let [dir (tool-dir opts infrastructure-tool)
        result (tofu/tofu-with-spec opts (infrastructure-specs opts)
                                    {:dir dir :env (credential-env opts :provider-compute)})]
    (cond
      (wf/failed? result) result
      (= :build (:green/event opts)) (merge result (fallback-params opts))
      (= :delete (:green/event opts)) result
      :else (resolved-compute result (fallback-params opts) (compute/output-params result)))))

(defn zone-id [zone] (format "${data.cloudflare_zone.zone.id}" zone))
(defn dns-json [opts]
  (tofu/constructs-json
   [(tofu/construct :resource :cloudflare_dns_record :restate
                    {:zone_id (zone-id (:restate-host opts))
                     :name (:restate-host opts) :content (:ip opts) :type "A"
                     :proxied true :ttl 1})]))
(defn dns-step [opts]
  (let [dir (tool-dir opts dns-tool)
        data (assoc opts :ip (or (:ip opts) (:ip (fallback-params opts))))
        specs [(spec (template "dns" "main.tf") (str dir "/main.tf") data)
               (raw-spec (str dir "/record.tf.json") (dns-json data))]]
    (tofu/tofu-with-spec opts specs {:dir dir :env (credential-env opts :provider-dns)})))

(defn ansible-local-data
  "Only what a `build` genuinely knows. The address, the user and the alias are
  run-time facts and reach the play as extra-vars instead, so the rendered
  playbook carries no IP and is identical on every workstation (SSH Config
  Standard §6)."
  [opts]
  (assoc opts
         :ssh-keygen (validate/keygen? opts)
         :ssh-config-identity-file (ssh-config/identity-file opts)))

(defn ansible-local-specs [opts]
  (let [dir (tool-dir opts ansible-local-tool) data (ansible-local-data opts)]
    [(spec (template "ansible-local" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible-local" "inventory.ini") (str dir "/inventory.ini") data)
     (spec (template "ansible-local" "main.yml") (str dir "/main.yml") data)]))

(defn ansible-local-step
  "Write or remove the `~/.ssh/config` block. The same playbook serves both
  events; `block_state` is what distinguishes them."
  [opts]
  (let [dir (tool-dir opts ansible-local-tool)
        delete? (= :delete (:green/event opts))]
    (ansible/ansible-with-spec opts
      {:dir dir :inventory "inventory.ini"
       :playbooks {:create "main.yml" :delete "main.yml"}
       :extra-vars {:host_alias (ssh-config/host-alias opts)
                    :ip (or (:ip opts) (:ip (fallback-params opts)))
                    :user (or (:user opts) "root")
                    :block_state (if delete? "absent" "present")}}
      (ansible-local-specs opts))))

(defn inventory [opts]
  (json/generate-string
   {:all {:children {:restate {:hosts {(:profile opts)
                                      {:ansible_host (or (:ip opts) "192.0.2.10")
                                       :ansible_user "root"}}}}}}
   {:pretty true}))
(defn ansible-data
  "Template values for the Ansible stage. `ssh-private-key-path` reaches
  ansible.cfg so convergence uses the deployment's own key in keygen mode,
  where nothing guarantees an agent holds it."
  [opts]
  (assoc opts
         :ip (or (:ip opts) "192.0.2.10")
         :ssh-keygen (validate/keygen? opts)
         :app-files ["Dockerfile" "package.json" "package-lock.json" "tsconfig.json" "src/index.ts"]
         :restate-backup-access-key "{{ lookup('env','COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID') }}"
         :restate-backup-secret-key "{{ lookup('env','COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY') }}"))
(defn ansible-specs [opts]
  (let [dir (tool-dir opts ansible-tool) data (ansible-data opts)]
    [(spec (template "ansible" "ansible.cfg") (str dir "/ansible.cfg") data)
     (spec (template "ansible" "main.yml") (str dir "/main.yml") data)
     (spec (template "ansible" "cleanup.yml") (str dir "/cleanup.yml") data)
     (spec (template "ansible" "compose.yml") (str dir "/compose.yml") data)
     (spec (template "ansible" "Caddyfile") (str dir "/Caddyfile") data)
     (spec (template "ansible" "backup") (str dir "/backup") data)
     (spec (template "ansible.app" "Dockerfile") (str dir "/app/Dockerfile") data)
     (spec (template "ansible.app" "package.json") (str dir "/app/package.json") data)
     (spec (template "ansible.app" "package-lock.json") (str dir "/app/package-lock.json") data)
     (spec (template "ansible.app" "tsconfig.json") (str dir "/app/tsconfig.json") data)
     (spec (template "ansible.app.src" "index.ts") (str dir "/app/src/index.ts") data)
     (raw-spec (str dir "/inventory.json") (inventory data))]))
(defn ansible-step [opts]
  (let [dir (tool-dir opts ansible-tool)]
    (if (and (= :delete (:green/event opts)) (not (:ip opts)))
      ;; No compute in state: there is no host to clean up, and the rendered
      ;; inventory would fall back to 192.0.2.10. Remove the rendered tree the
      ;; way a completed cleanup would and let the teardown continue.
      (assoc (sc/scaffold opts (ansible-specs opts))
             :green/exit 0 :restate/cleanup :skipped-no-compute)
      (ansible/ansible-with-spec opts
        {:dir dir :inventory "inventory.json"
         :playbooks {:create "main.yml" :delete "cleanup.yml"}
         :host-key-checking false}
        (ansible-specs opts)))))

(defn run-json [args timeout]
  (let [r (process/run-with-timeout args {} timeout)]
    (if (zero? (:exit r))
      [(try (json/parse-string (:out r) true) (catch Exception _ nil)) nil]
      [nil (str (:err r) (:out r))])))
(defn wait-health [url attempts]
  (loop [n attempts]
    (let [r (process/run-with-timeout ["curl" "-fsS" (str url "/health")] {} 10000)]
      (cond (zero? (:exit r)) true
            (pos? n) (do (Thread/sleep 5000) (recur (dec n)))
            :else false))))
(defn acceptance-step [opts]
  (if (not= :create (:green/event opts))
    (assoc opts :green/exit 0)
    (let [base (str "https://" (:restate-host opts))
          id (str "acceptance-" (System/currentTimeMillis))]
      (if-not (wait-health base 60)
        (assoc opts :green/exit 1 :green/err "HTTPS health did not become ready")
        (let [[started start-err] (run-json ["curl" "-fsS" "-X" "POST"
                                             "-H" "content-type: application/json"
                                             "--data" "{\"value\":7}"
                                             (str base "/workflows/" id)] 15000)
              [duplicate duplicate-err] (run-json ["curl" "-fsS" "-X" "POST"
                                                   "-H" "content-type: application/json"
                                                   "--data" "{\"value\":7}"
                                                   (str base "/workflows/" id)] 15000)
              ;; The deployment's own key is selected in keygen mode
              ;; (`ssh/identity-args`), because nothing guarantees an agent
              ;; holds it; opt-out mode adds nothing.
              reboot (process/run-with-timeout
                      (-> ["ssh" "-o" "StrictHostKeyChecking=no" "-o" "ConnectTimeout=10"]
                          (into (ssh/identity-args opts))
                          (conj (str "root@" (:ip opts)) "systemctl reboot"))
                      {} 20000)]
          (cond
            start-err (assoc opts :green/exit 1 :green/err (str "workflow start failed: " start-err))
            duplicate-err (assoc opts :green/exit 1 :green/err (str "duplicate start failed: " duplicate-err))
            (not= (:workflowId started) (:workflowId duplicate))
            (assoc opts :green/exit 1 :green/err "duplicate start did not return the same workflow ID")
            (not (wait-health base 90))
            (assoc opts :green/exit 1 :green/err "HTTPS did not recover after Droplet restart")
            :else
            (loop [n 90]
              (let [[status err] (run-json ["curl" "-fsS" (str base "/workflows/" id)] 10000)]
                (cond
                  (and status (= "completed" (:status status))
                       (= 3 (get-in status [:result :activityAttempts]))
                       (= (* 7 7) (get-in status [:result :result])))
                  (assoc opts :green/exit 0 :restate/acceptance status)
                  (zero? n) (assoc opts :green/exit 1 :green/err
                                   (str "workflow did not complete after restart: " (or err status)))
                  :else (do (Thread/sleep 3000) (recur (dec n))))))))))))
