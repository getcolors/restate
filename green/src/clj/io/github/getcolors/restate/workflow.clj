(ns io.github.getcolors.restate.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.restate.ssh :as ssh]
            [io.github.getcolors.restate.ssh-config :as ssh-config]
            [io.github.getcolors.restate.tools :as tools]
            [io.github.getcolors.restate.validate :as validate]))

(def defaults {:provider-compute validate/default-compute-provider
               :provider-dns "cloudflare"
               :provider-backend "local" :compute-prevent-destroy true
               :workdir ".colors"})

(defn state-output
  "Compute params recorded in the infrastructure state; nil when the state
  holds none. An unreadable backend throws the SDK's step error, which
  `compute/read-state` turns into `{:error message}` -- create and delete
  treat the two differently. Kept local so tests can redefine it."
  [opts]
  (some-> (tofu/outputs (tools/tool-dir opts tools/infrastructure-tool)
                        (tools/backend-credential-env opts))
          :params walk/keywordize-keys))

(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   ;; The state is read once, up front, on the same defaulted and overlaid
   ;; opts the validators see -- the overlay is what carries the backend
   ;; credentials -- and only for the two events that touch a provider. The
   ;; validator and the after-validate share the one read.
   (let [overlaid (green-cli/read-pars (merge defaults opts) env)
         context {:event (:green/event overlaid) :real? (lifecycle/real-run? overlaid)}
         state (when (compute/lifecycle-event? context)
                 (compute/read-state overlaid state-output))]
     (lifecycle/preflight
      opts {:defaults defaults :overlay green-cli/read-pars
            :validators
            [(fn [_ env _] (validate/env-errors env))
             (fn [opts _ _] (validate/state-errors opts))
             ;; Standard §4 before the credentials: a recorded provider that
             ;; differs from the selected one reports the actionable error, not
             ;; a missing token for the provider that was just selected.
             (fn [opts _ ctx]
               (when (compute/lifecycle-event? ctx)
                 (compute/provider-validator validate/spec opts (:params state)
                                             #(validate/secret-errors opts))))
             (fn [opts _ {:keys [event real?]}]
               (when (and real? (= :delete event) (:compute-prevent-destroy opts))
                 [(str "compute destruction is protected; set "
                       (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
            :after-validate
            ;; The machine key's create matrix and the provider preflight run
            ;; before any template is rendered: an unowned key on disk or at
            ;; the provider stops the run while stopping is still free. Delete
            ;; fills the same template values -- a destroy renders before it
            ;; destroys -- and adopts the recorded address (ONCE's
            ;; `adopt-state`, fail-closed on an unreadable backend, no address
            ;; override), but checks no key, because its key cleanup runs
            ;; after the compute destroy.
            (fn [opts _ {:keys [event real?]}]
              (cond
                (and real? (= :delete event))
                (compute/adopt-state opts :delete state)

                (and real? (= :create event))
                (let [opts (ssh/ensure-key! opts (fn [_] (:params state)))]
                  (if (wf/failed? opts)
                    opts
                    (let [opts (ssh/preflight! (ssh/with-machine-key opts))
                          opts (if (wf/failed? opts) opts (ssh-config/preflight! opts))]
                      (if (wf/failed? opts) opts (assoc opts :green/exit 0)))))

                :else
                (assoc (ssh/with-machine-key opts) :green/exit 0)))} env))))

(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :restate/start [start-step :restate/ansible]
      :restate/ansible [tools/ansible-step :restate/dns]
      ;; The `~/.ssh/config` block goes before the destroy, the opposite of the
      ;; keypair below. A block that outlives its host is stale but harmless; a
      ;; key that predeceases its host locks the operator out of a machine that
      ;; still exists. Both orders are deliberate; see standards/ssh-config.md.
      :restate/dns [tools/dns-step :restate/ssh-config]
      :restate/ssh-config [tools/ansible-local-step :restate/infrastructure]
      ;; The keypair goes strictly after the compute destroy: a key that
      ;; predeceases its host locks the operator out of a machine that still
      ;; exists (SSH Keypair Standard §3.3).
      :restate/infrastructure [tools/infrastructure-step :restate/ssh-cleanup]
      :restate/ssh-cleanup [ssh/cleanup-step])
    (case step
      :restate/start [start-step :restate/infrastructure]
      ;; After compute, which is where the address first exists, and before the
      ;; stage that converges the machine.
      :restate/infrastructure [tools/infrastructure-step :restate/ssh-config]
      :restate/ssh-config [tools/ansible-local-step :restate/dns]
      :restate/dns [tools/dns-step :restate/ansible]
      :restate/ansible [tools/ansible-step :restate/acceptance]
      :restate/acceptance [tools/acceptance-step])))
(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))
(def side-effecting [:restate/infrastructure :restate/dns :restate/ssh-config
                     :restate/ansible :restate/acceptance :restate/ssh-cleanup])
(def workflow
  (-> (wf/workflow {:start :restate/start :wire-fn wire-fn})
      (wf/advice-add :restate/infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :restate/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting)))
