package service

import (
	"time"

	_ "ariga.io/atlas-provider-gorm/gormschema"
)

// Example model - User represents a user in the system
type User struct {
	ID        uint      `gorm:"primaryKey;autoIncrement"`
	Email     string    `gorm:"type:text;not null;uniqueIndex"`
	Name      string    `gorm:"type:text;not null"`
	CreatedAt time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt time.Time `gorm:"type:timestamp(3);not null"`
}

// Example model - Job represents a job posting or opportunity
type Job struct {
	ID          uint       `gorm:"primaryKey;autoIncrement"`
	Title       string     `gorm:"type:text;not null"`
	Description string     `gorm:"type:text"`
	URL         string     `gorm:"type:text"`
	Source      string     `gorm:"type:text"` // e.g., "upwork", "linkedin", etc.
	Status      string     `gorm:"type:text"` // e.g., "new", "applied", "rejected", etc.
	UserID      *uint      `gorm:"index"`
	User        *User      `gorm:"foreignKey:UserID"`
	CreatedAt   time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt   time.Time  `gorm:"type:timestamp(3);not null"`
	AppliedAt   *time.Time `gorm:"type:timestamp(3)"`
}

// Profile stores customizable freelancer metadata used during analysis
type Profile struct {
	ID             uint            `gorm:"primaryKey;autoIncrement"`
	Description    string          `gorm:"type:text"`
	Skills         string          `gorm:"type:text"`
	PortfolioItems []PortfolioItem `gorm:"foreignKey:ProfileID"`
	CreatedAt      time.Time       `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt      time.Time       `gorm:"type:timestamp(3);not null"`
}

// PortfolioItem represents a single portfolio entry
type PortfolioItem struct {
	ID          uint      `gorm:"primaryKey;autoIncrement"`
	ProfileID   uint      `gorm:"index"`
	Title       string    `gorm:"type:text"`
	Link        string    `gorm:"type:text"`
	Description string    `gorm:"type:text"`
	CreatedAt   time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt   time.Time `gorm:"type:timestamp(3);not null"`
}
