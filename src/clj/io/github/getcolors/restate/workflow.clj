(ns io.github.getcolors.restate.workflow
  (:require [clojure.walk :as walk]
            [green.cli :as green-cli]
            [green.dry-run :as dry-run]
            [green.lifecycle :as lifecycle]
            [green.progress :as progress]
            [green.tofu :as tofu]
            [green.workflow :as wf]
            [io.github.getcolors.restate.tools :as tools]
            [io.github.getcolors.restate.validate :as validate]))

(def defaults {:provider-compute "digitalocean" :provider-dns "cloudflare"
               :provider-backend "local" :compute-prevent-destroy true
               :workdir ".colors"})
(defn state-output [opts]
  (try (some-> (tofu/outputs (tools/tool-dir opts tools/infrastructure-tool)
                             (tools/backend-credential-env opts))
               :params walk/keywordize-keys)
       (catch Exception _ nil)))
(defn start-step
  ([opts] (start-step opts (System/getenv)))
  ([opts env]
   (lifecycle/preflight
    opts {:defaults defaults :overlay green-cli/read-pars
          :validators
          [(fn [_ env _] (validate/env-errors env))
           (fn [opts _ _] (validate/state-errors opts))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (contains? #{:create :delete} event))
               (validate/secret-errors opts)))
           (fn [opts _ {:keys [event real?]}]
             (when (and real? (= :delete event) (:compute-prevent-destroy opts))
               [(str "compute destruction is protected; set "
                     (green-cli/par-name :compute-prevent-destroy) "=false to delete")]))]
          :after-validate
          (fn [opts _ {:keys [event real?]}]
            (if (and real? (= :delete event))
              (merge opts (or (state-output opts) {}) {:green/exit 0})
              (assoc opts :green/exit 0)))} env)))
(defn wire-fn [step run-opts]
  (if (= :delete (:green/event run-opts))
    (case step
      :restate/start [start-step :restate/ansible]
      :restate/ansible [tools/ansible-step :restate/dns]
      :restate/dns [tools/dns-step :restate/infrastructure]
      :restate/infrastructure [tools/infrastructure-step])
    (case step
      :restate/start [start-step :restate/infrastructure]
      :restate/infrastructure [tools/infrastructure-step :restate/dns]
      :restate/dns [tools/dns-step :restate/ansible]
      :restate/ansible [tools/ansible-step :restate/acceptance]
      :restate/acceptance [tools/acceptance-step])))
(defn backend-advice [tool]
  (tofu/conventional-backend-advice
   {:dir-fn #(tools/tool-dir % tool)
    :key-fn #(str (:profile %) "/" tool ".tfstate")}))
(def side-effecting [:restate/infrastructure :restate/dns :restate/ansible :restate/acceptance])
(def workflow
  (-> (wf/workflow {:start :restate/start :wire-fn wire-fn})
      (wf/advice-add :restate/infrastructure :before ::backend
                     (backend-advice tools/infrastructure-tool))
      (wf/advice-add :restate/dns :before ::backend (backend-advice tools/dns-tool))
      progress/advise
      (dry-run/advise side-effecting)))
