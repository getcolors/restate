(ns io.github.getcolors.restate.workflow-test
 (:require [clojure.test :refer [deftest is]]
 [io.github.getcolors.restate.workflow :as workflow]
 [io.github.getcolors.restate.compute :as compute]
 [io.github.getcolors.restate.validate-test :refer [keygen fixture]]))
(deftest offline-start
 (doseq [f [keygen fixture]]
  (is (= 0 (:green/exit (workflow/start-step (assoc (f) :green/event :build) {}))))))
(deftest singleton-library-contract
 (is (= [{:role nil :count 1}] compute/topology))
 (is (= ["restate-keygen-fixture/restate-infrastructure.tfstate"] (:legacy_state_keys (compute/requirements (keygen))))))
(deftest errors-and-observed-nodes
 (is (= "legacy compute state requires migration" (:green/err (compute/attach (keygen) {:status "error" :errors ["legacy compute state requires migration"]}))))
 (is (= "ubuntu" (:user (compute/attach (keygen) {:status "present" :cluster {:nodes [{:ip "203.0.113.7" :user "ubuntu"}]}}))))
 (is (:restate/already-destroyed (compute/attach (keygen) {:status "destroyed"}))))

(deftest library-document-keys-render-deterministically
 (is (= (#'io.github.getcolors.restate.compute/compute-json {"a" 0 :b 1} 0)
        (#'io.github.getcolors.restate.compute/compute-json {:a 0 "b" 1} 0))))
