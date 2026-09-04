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

(deftest the-spec-carries-this-packages-registry-sources-and-default
  ;; The operations are ONCE's; this is the data they run over. A colour
  ;; whose registry, sources or default drifts fails here, in that colour.
  (is (= #{"digitalocean"} (set (keys (:registry validate/spec)))))
  (is (= validate/compute-providers (:registry validate/spec)))
  (is (= {:required [:digitalocean-region :digitalocean-size :digitalocean-image
                     :digitalocean-ssh-sources :digitalocean-http-sources]
          :secrets [:do-token]
          :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}
         (get-in validate/spec [:registry "digitalocean"])))
  (is (= {:non-empty ["ssh-sources"] :may-be-empty ["http-sources"]} (:sources validate/spec)))
  ;; The default is what a legacy state without params.provider is, and the
  ;; only provider this package ever offered is DigitalOcean.
  (is (= "digitalocean" (:default validate/spec)))
  (is (= validate/default-compute-provider (:default validate/spec)))
  (is (not (contains? validate/spec :name-rules)) "the name rules are ONCE's"))

;; --- the compute-provider registry

(deftest compute-provider-must-be-one-the-package-has-a-template-for
  ;; The registry is the only list; a provider accepted here with no template
  ;; directory would fail at render time instead of at validation.
  (let [errors (validate/state-errors (fixture :provider-compute "vultr"))]
    (is (some #{":provider-compute must be one of digitalocean"} errors))))

(deftest keys-of-an-unselected-provider-are-ignored
  ;; One colors.yml may carry another provider's block; nothing refuses it.
  (is (= [] (validate/state-errors (fixture :vultr-region "ams" :vultr-os-id "ubuntu")))))

(deftest name-and-machine-key-are-never-required
  ;; `digitalocean-name` is an optional override of the profile and
  ;; `digitalocean-ssh-keys` is meaningful by its absence, so neither may be in
  ;; the registry's required list -- a required machine key would make keygen
  ;; mode unreachable.
  (doseq [entry (vals validate/compute-providers) k (:required entry)]
    (is (not (str/ends-with? (name k) "-name")) (str k))
    (is (not (str/ends-with? (name k) "-ssh-keys")) (str k)))
  (is (= [] (validate/state-errors (fixture :digitalocean-name nil :digitalocean-ssh-keys nil))))
  (is (some #(str/includes? % "digitalocean-size")
            (validate/state-errors (fixture :digitalocean-size nil)))))

(deftest absent-machine-key-selects-keygen
  (is (validate/keygen? (keygen)))
  (is (not (validate/keygen? (fixture))))
  (is (validate/keygen? (fixture :digitalocean-ssh-keys nil)) "absence, not a flag, is the switch"))

(deftest compute-name-falls-back-to-the-profile
  (is (= "restate-fixture" (validate/compute-name (fixture))))
  (is (= "restate-keygen-fixture" (validate/compute-name (keygen))))
  (is (= "custom" (validate/compute-name (fixture :digitalocean-name "custom"))))
  (is (= :digitalocean-ssh-sources (validate/compute-key (fixture) "ssh-sources"))))

(deftest a-name-override-is-validated-against-the-providers-rules
  (is (some #(str/includes? % ":digitalocean-name must be a hostname-like name")
            (validate/state-errors (fixture :digitalocean-name "Not Valid!")))))

(deftest compute-credentials-follow-the-provider
  (is (= {:do-token "DIGITALOCEAN_TOKEN"} (validate/tofu-env (fixture) :provider-compute)))
  (is (str/includes? (str/join "\n" (validate/secret-errors (fixture))) "COLORS_PAR_DO_TOKEN")))

;; --- the network contract, wired through state-errors with ONCE's messages

(deftest ssh-sources-must-not-be-empty
  ;; A machine nobody can reach is not a deployment; an empty HTTP list is
  ;; simply no public HTTP.
  (is (some #{":digitalocean-ssh-sources must list at least one CIDR"}
            (validate/state-errors (fixture :digitalocean-ssh-sources []))))
  (is (= [] (validate/state-errors (fixture :digitalocean-http-sources [])))))

(deftest malformed-sources-are-refused-before-any-provider-call
  (is (some #{":digitalocean-http-sources entry \"203.0.113.0\" is not an IPv4 or IPv6 CIDR"}
            (validate/state-errors (fixture :digitalocean-http-sources ["203.0.113.0"]))))
  (is (some #{":digitalocean-ssh-sources entry \"nope\" is not an IPv4 or IPv6 CIDR"}
            (validate/state-errors (fixture :digitalocean-ssh-sources ["0.0.0.0/0" "nope"]))))
  (is (= [] (validate/state-errors (fixture :digitalocean-ssh-sources ["2001:db8::/32" "203.0.113.4/32"])))))

;; --- provider checks run only for the selected provider

(deftest provider-checks-are-scoped-to-the-selected-provider
  (testing "DigitalOcean's VPC keys are refused on DigitalOcean, with the same wording as before"
    (is (some #{":digitalocean-vpc-cidr must be absent; this package must not create a VPC"}
              (validate/state-errors (fixture :digitalocean-vpc-cidr "10.0.0.0/16"))))
    (is (some #{":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"}
              (validate/state-errors (fixture :digitalocean-vpc-uuid "forbidden"))))))

(deftest reports-all-errors
  (let [errors (validate/state-errors
                (fixture :restate-host "bad" :restate-image "floating"
                         :reference-app-delay-seconds -1
                         :provider-dns "other" :digitalocean-vpc-uuid "forbidden"))]
    (is (<= 5 (count errors)))
    (doseq [part ["host" "image" "delay" "provider-dns" "vpc-uuid"]]
      (is (some #(str/includes? % part) errors)))))
(deftest forbids-vpc-configuration
  (is (some #(str/includes? % "must be absent")
            (validate/state-errors (fixture :digitalocean-vpc-cidr "10.0.0.0/16")))))
(deftest profile-overlay-is-refused
  (is (seq (validate/env-errors {"COLORS_PAR_PROFILE" "other"})))
  (is (nil? (validate/env-errors {}))))
(deftest names-all-package-secrets
  (let [errors (str/join "\n" (validate/secret-errors (fixture)))]
    (doseq [name ["COLORS_PAR_DO_TOKEN" "COLORS_PAR_CLOUDFLARE_API_TOKEN"
                  "COLORS_PAR_R2_ACCESS_KEY_ID" "COLORS_PAR_R2_SECRET_ACCESS_KEY"
                  "COLORS_PAR_RESTATE_BACKUP_R2_ACCESS_KEY_ID"
                  "COLORS_PAR_RESTATE_BACKUP_R2_SECRET_ACCESS_KEY"]]
      (is (str/includes? errors name)))))
