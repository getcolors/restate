(ns io.github.getcolors.restate.validate
  (:require [clojure.string :as str]
            [green.cli :as green-cli]
            [io.github.getcolors.once.validate :as once-validate]))

(def profile-par (green-cli/par-name :profile))
(def required
  [:profile :workdir :provider-compute :provider-dns :provider-backend
   :compute-prevent-destroy :restate-host :restate-node-name :restate-image
   :restate-typescript-sdk-version :restate-data-dir :restate-backup-dir
   :reference-app-delay-seconds :reference-app-max-activity-attempts
   :reference-app-fail-activity-attempts :caddy-image
   :restate-backup-r2-bucket :restate-backup-r2-endpoint
   :restate-backup-r2-region :restate-backup-oncalendar
   :restate-backup-retention-days :digitalocean-name :digitalocean-region
   :digitalocean-size :digitalocean-image :digitalocean-ssh-keys
   :digitalocean-ssh-sources :digitalocean-http-sources
   :r2-bucket :r2-endpoint])
(def host-re #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$")
(def image-re #"^[^\s:@]+(?:/[^\s:@]+)*:[^\s:@]+$")
(defn missing? [x] (or (nil? x) (and (string? x) (str/blank? x))))
(defn env-errors [env]
  (when (not-empty (str (get env profile-par)))
    [(str profile-par " is set; profile must come from colors.yml only")]))

(defn state-errors [opts]
  (vec
   (concat
    (for [k required :when (missing? (get opts k))] (str k " is required"))
    (when-not (= "digitalocean" (:provider-compute opts))
      [":provider-compute must be digitalocean"])
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
    (when (contains? opts :digitalocean-vpc-uuid)
      [":digitalocean-vpc-uuid must be absent; the default regional VPC is discovered at runtime"])
    (when (contains? opts :digitalocean-vpc-cidr)
      [":digitalocean-vpc-cidr must be absent; this package must not create a VPC"]))))

(defn backend-secrets [opts]
  (:secrets (get-in once-validate/providers
                    [:provider-backend (:provider-backend opts)])))
(defn secret-errors [opts]
  (let [keys (concat [:do-token :cloudflare-api-token
                      :restate-backup-r2-access-key-id
                      :restate-backup-r2-secret-access-key]
                     (backend-secrets opts))]
    (for [k (distinct keys) :when (missing? (get opts k))]
      (str "required credential is not set: " (green-cli/par-name k)))))

(defn tofu-env [opts slot]
  (case slot
    :provider-compute {:do-token "DIGITALOCEAN_TOKEN"}
    :provider-dns {:cloudflare-api-token "CLOUDFLARE_API_TOKEN"}
    :provider-backend (:tofu-env (get-in once-validate/providers
                                         [:provider-backend (:provider-backend opts)]) {})
    {}))
