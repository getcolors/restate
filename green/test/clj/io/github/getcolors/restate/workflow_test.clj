(ns io.github.getcolors.restate.workflow-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is]]
            [io.github.getcolors.restate.validate-test :refer [fixture]]
            [io.github.getcolors.restate.workflow :as workflow]))
(deftest build-and-dry-run-need-no-credentials
  (is (= 0 (:green/exit (workflow/start-step (assoc (fixture) :green/event :build) {}))))
  (is (= 0 (:green/exit (workflow/start-step
                         (assoc (fixture) :green/event :create :green/dry-run true) {})))))
(deftest real-create-requires-credentials
  (let [r (workflow/start-step (assoc (fixture) :green/event :create) {})]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COLORS_PAR_DO_TOKEN"))
    (is (str/includes? (:green/err r) "COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY"))))
(deftest delete-is-protected
  (let [r (workflow/start-step (assoc (fixture) :green/event :delete) {})]
    (is (= 2 (:green/exit r)))
    (is (str/includes? (:green/err r) "COMPUTE_PREVENT_DESTROY"))))
(deftest graph-orders-private-stack
  (is (= [:restate/infrastructure]
         (vec (rest (workflow/wire-fn :restate/start {:green/event :create})))))
  (is (= [:restate/dns]
         (vec (rest (workflow/wire-fn :restate/infrastructure {:green/event :create})))))
  (is (= [:restate/ansible]
         (vec (rest (workflow/wire-fn :restate/start {:green/event :delete}))))))
