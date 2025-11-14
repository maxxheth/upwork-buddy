data "external_schema" "app" {
  program = [
    "go",
    "run",
    "-mod=mod",
    "./internal/database/service/loader",
  ]
}

env "app" {
  src = data.external_schema.app.url
  dev = "docker://postgres/15/dev"
  url = "postgres://postgres:password@localhost:5443/upwork_buddy?sslmode=disable"
  migration {
    dir = "file://internal/database/migrations/app"
  }
  format {
    migrate {
      diff = "{{ sql . \"  \" }}"
    }
  }
}
