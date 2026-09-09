(ns io.github.getcolors.restate.validate-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [green.cli :as green-cli]
            [io.github.getcolors.restate.validate :as validate]))

(def fixture-file "test/fixtures/colors.yml")
(def keygen-file "test/fixtures/keygen.yml")
(defn read-fixture [file overrides]
  (merge (green-cli/read-state file (str/replace (slurp file) "WORKDIR" ".colors"))
         overrides))
(defn fixture
  "DigitalOcean, opt-out mode: an explicit key id and a name equal to the profile."
  [& {:as overrides}] (read-fixture fixture-file overrides))
(defn keygen
  "DigitalOcean, keygen mode: no `digitalocean-ssh-keys`, no `digitalocean-name`."
  [& {:as overrides}] (read-fixture keygen-file overrides))

(deftest fixture-is-valid (is (= [] (validate/state-errors (fixture)))))
(deftest keygen-fixture-is-valid (is (= [] (validate/state-errors (keygen)))))

;; --- the spec handed to ONCE

(deftest keys-of-an-unselected-provider-are-ignored
  ;; One colors.yml may carry another provider's block; nothing refuses it.
  (is (= [] (validate/state-errors (fixture :vultr-region "ams" :vultr-os-id "ubuntu")))))

(deftest absent-machine-key-selects-keygen
  (is (validate/keygen? (keygen)))
  (is (not (validate/keygen? (fixture))))
  (is (validate/keygen? (fixture :digitalocean-ssh-keys nil)) "absence, not a flag, is the switch"))

(deftest a-name-override-is-validated-against-the-providers-rules
  (is (some #(str/includes? % "invalid compute deployment requirements")
            (validate/state-errors (fixture :digitalocean-name "Not Valid!")))))

(deftest reports-all-errors
  (let [errors (validate/state-errors
                (fixture :restate-host "bad" :restate-image "floating"
                         :reference-app-delay-seconds -1
                         :provider-dns "other" :digitalocean-vpc-uuid "forbidden"))]
    (is (<= 5 (count errors)))
    (doseq [part ["host" "image" "delay" "provider-dns" "compute deployment"]]
      (is (some #(str/includes? % part) errors)))))
(deftest profile-overlay-is-refused
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "other"})))
  (is (nil? (validate/env-errors {}))))
