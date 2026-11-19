data "external_schema" "app" {
  working_dir = "./tools/atlas-loader"
  program = [
    "go",
    "run",
    ".",
  ]
}

locals {
  db_user        = getenv("APP_DB_USERNAME") != "" ? getenv("APP_DB_USERNAME") : "postgres"
  db_pass        = getenv("APP_DB_PASSWORD")
  db_host        = getenv("APP_DB_HOST") != "" ? getenv("APP_DB_HOST") : "localhost"
  db_port        = getenv("APP_DB_PORT") != "" ? getenv("APP_DB_PORT") : "5443"
  db_name        = getenv("APP_DB_DATABASE") != "" ? getenv("APP_DB_DATABASE") : "upwork_buddy"
  default_db_url = local.db_pass != "" ? "postgres://${local.db_user}:${local.db_pass}@${local.db_host}:${local.db_port}/${local.db_name}?sslmode=disable&search_path=public" : ""
}

env "app" {
  src = data.external_schema.app.url
  dev = getenv("ATLAS_DEV_URL") != "" ? getenv("ATLAS_DEV_URL") : "docker://postgres/17/dev?search_path=public"
  url = getenv("APP_DB_URL") != "" ? getenv("APP_DB_URL") : local.default_db_url
  migration {
    dir = "file://internal/database/migrations/app"
  }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}
