(ns io.github.getcolors.restate.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.compute :as compute]
            [io.github.getcolors.once.ssh :as once-ssh]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))

(def compute-providers
  "provider-compute -> what that choice implies.

  `:required` are the non-secret keys that provider's template interpolates,
  `:secrets` the credentials it needs through COLORS_PAR_*, and `:tofu-env` the
  subset OpenTofu reads from the process environment itself. Keeping the three
  together is what stops a provider being validated against one set of keys and
  run with another -- a stage exporting a credential nobody checked for, or a
  check demanding a key no template uses. The keys of this map are the
  advertised providers; a provider without a template directory and a golden
  is not advertised. One entry today: this package puts a provider firewall in
  front of the host, so the sources are required where ONCE's own compute
  templates need none.

  Two keys the template reads are deliberately not required. `digitalocean-name`
  is an optional override of the profile (Compute Name Standard), and
  `digitalocean-ssh-keys` is meaningful by its absence (SSH Keypair Standard)."
  {"digitalocean"
   {:required [:digitalocean-region :digitalocean-size :digitalocean-image
               :digitalocean-ssh-sources :digitalocean-http-sources]
    :secrets [:do-token]
    :tofu-env {:do-token "DIGITALOCEAN_TOKEN"}}})

(def default-compute-provider
  "The provider a deployment created before this package recorded one in its
  compute output must be running: the only one it ever offered. A legacy
  state -- `params` without `provider` -- is whatever this value says it is,
  and `restate-digitalocean`'s R2 state may still hold one."
  "digitalocean")

(def spec
  "How this package describes itself to ONCE's `compute`, the Compute Provider
  Standard's operations over a package-owned registry. The registry and the
  default are the data above; `:sources` names the firewall lists the
  template reads -- SSH must list at least one CIDR, an empty HTTP list means
  no public HTTP. The name rules are ONCE's."
  {:registry compute-providers
   :default default-compute-provider
   :sources {:non-empty ["ssh-sources"] :may-be-empty ["http-sources"]}})

(def required
  "Every key desired state must carry whichever provider is selected. The
  provider-scoped keys come from `compute-providers`."
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy :restate-host :restate-node-name :restate-image
   :restate-typescript-sdk-version :restate-data-dir :restate-backup-dir
   :reference-app-delay-seconds :reference-app-max-activity-attempts
   :reference-app-fail-activity-attempts :caddy-image
   :restate-backup-r2-bucket :restate-backup-r2-endpoint
   :restate-backup-r2-region :restate-backup-oncalendar
   :restate-backup-retention-days
   :r2-bucket :r2-endpoint])
(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*:[^\s:@]+$")
(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))
(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(def compute-key
  "`:<provider>-<suffix>`: desired state names compute keys after the
  provider, so the shared steps reach them through the selected provider
  rather than a fixed prefix. ONCE's; named here so `tools` reads the same."
  compute/key)

(def compute-name
  "What this deployment's machine is called: `digitalocean-name` when present,
  else the profile (Compute Name Standard). ONCE's; the template derives the
  Droplet name, the firewall name and `params.name` from this one answer."
  compute/name)

(defn keygen?
  "Whether this deployment owns its machine keypair. Delegates to ONCE, the
  standard's reference implementation, so one rule decides it everywhere."
  [opts]
  (once-ssh/keygen? opts))

(def cidrs
  "A source list as desired state or an overlay string carries it. ONCE's, so
  the validator and the template can never disagree about what an entry is."
  compute/cidrs)

(defn state-errors
  "Every problem with desired state at once: the missing keys (this package's
  and the selected provider's), the package's own checks, then the Compute
  Provider Standard's -- selection, the network contract and the provider
  rules, DigitalOcean's VPC refusal among them -- which are ONCE's over
  `spec`."
  [opts]
  (vec
   (concat
    (for [k (concat required (compute/required-keys spec opts))
          :when (missing? (get opts k))]
      (str k " is required"))
    (when-not (= "cloudflare" (:provider-dns opts))
      [":provider-dns must be cloudflare"])
    (when-not (contains? #{"local" "s3" "r2"} (:provider-backend opts))
      [":provider-backend must be local, s3, or r2"])
    (when-not (boolean? (:compute-prevent-destroy opts))
      [":compute-prevent-destroy must be true or false"])
    (when-not (or (missing? (:restate-host opts))
                  (re-matches host-re (str (:restate-host opts))))
      [":restate-host must be a fully qualified hostname"])
    (for [k [:restate-image :caddy-image]
          :let [v (get opts k)]
          :when (and (not (missing? v)) (not (re-matches image-re (str v))))]
      (str k " must carry an explicit image tag"))
    (for [k [:reference-app-delay-seconds :reference-app-max-activity-attempts
             :reference-app-fail-activity-attempts :restate-backup-retention-days]
          :when (and (not (missing? (get opts k)))
                     (not (and (integer? (get opts k)) (pos? (get opts k)))))]
      (str k " must be a positive integer"))
    (when (and (integer? (:reference-app-max-activity-attempts opts))
               (integer? (:reference-app-fail-activity-attempts opts))
               (<= (:reference-app-max-activity-attempts opts)
                   (:reference-app-fail-activity-attempts opts)))
      [":reference-app-max-activity-attempts must exceed :reference-app-fail-activity-attempts"])
    (compute/state-errors spec opts))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))
(defn secret-errors
  "Credentials a real create or delete needs: the selected compute provider's,
  Cloudflare's, the backup bucket's, and the backend's."
  [opts]
  (let [keys (concat (compute/secrets spec opts)
                     [:cloudflare-api-token
                      :restate-backup-r2-access-key-id
                      :restate-backup-r2-secret-access-key]
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute (compute/tofu-env spec opts)
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
