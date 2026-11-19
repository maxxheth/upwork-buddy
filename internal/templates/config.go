package templates

import (
	"os"

	"go.yaml.in/yaml/v3"
)

// DocRef is a documentation URL with a label
type DocRef struct {
	URL   string `yaml:"url"`
	Label string `yaml:"label"`
}

// AgentBlueprint defines an agent to be generated
type AgentBlueprint struct {
	Name        string `yaml:"name"`
	Title       string `yaml:"title"`
	Description string `yaml:"description"`
}

// TemplateCategory is a single template category entry
type TemplateCategory struct {
	Name            string           `yaml:"name"`
	DisplayName     string           `yaml:"display_name"`
	Description     string           `yaml:"description"`
	Icon            string           `yaml:"icon"`
	Docs            []DocRef         `yaml:"docs"`
	AgentBlueprints []AgentBlueprint `yaml:"agent_blueprints"`
}

// Config is the top-level templates.yaml structure
type Config struct {
	Templates []TemplateCategory `yaml:"templates"`
}

// Load reads and parses the templates.yaml file from the given path.
// Falls back to "templates.yaml" in the current directory.
func Load(path string) (*Config, error) {
	if path == "" {
		path = "templates.yaml"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}