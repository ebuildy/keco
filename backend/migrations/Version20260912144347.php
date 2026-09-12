<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Discovery write model (AGENTS.md §4.1): `discovery_repos`/`discovery_runs`/`discovery_state`,
 * replacing the TS `DiscoveryStore`'s three DataStore collections. Also creates
 * `messenger_messages`, the Doctrine transport table Symfony Messenger needs for
 * `async_discovery` (`MESSENGER_TRANSPORT_DSN` is configured `auto_setup=0`, so schema changes
 * go through migrations here too, never `messenger:setup-transports`'s own DDL) — this is the
 * first bounded context to need a real transport, so it's the natural place to add the table.
 */
final class Version20260912144347 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Discovery write model (discovery_repos/discovery_runs/discovery_state) and the messenger_messages transport table.';
    }

    public function up(Schema $schema): void
    {
        $this->addSql('CREATE TABLE discovery_repos (id VARCHAR(140) NOT NULL, repo_id INT NOT NULL, query_slug VARCHAR(100) NOT NULL, query VARCHAR(255) NOT NULL, full_name VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL, owner VARCHAR(255) NOT NULL, description TEXT DEFAULT NULL, homepage VARCHAR(500) DEFAULT NULL, stars INT NOT NULL, forks INT NOT NULL, open_issues INT NOT NULL, language VARCHAR(100) DEFAULT NULL, license VARCHAR(100) DEFAULT NULL, topics JSON NOT NULL, archived BOOLEAN NOT NULL, fork BOOLEAN NOT NULL, default_branch VARCHAR(255) NOT NULL, github_created_at VARCHAR(40) NOT NULL, github_updated_at VARCHAR(40) NOT NULL, github_pushed_at VARCHAR(40) DEFAULT NULL, discovered_via VARCHAR(500) NOT NULL, discovered_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, payload_hash VARCHAR(32) NOT NULL, first_seen_run_id VARCHAR(32) NOT NULL, last_seen_run_id VARCHAR(32) NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX idx_discovery_repos_query_slug ON discovery_repos (query_slug)');
        $this->addSql('CREATE INDEX idx_discovery_repos_stars ON discovery_repos (stars)');
        $this->addSql('CREATE TABLE discovery_runs (id UUID NOT NULL, query VARCHAR(255) NOT NULL, query_slug VARCHAR(100) NOT NULL, started_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, ended_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, duration_ms BIGINT DEFAULT NULL, outcome VARCHAR(16) NOT NULL, fresh BOOLEAN NOT NULL, run_limit INT DEFAULT NULL, pages_fetched INT NOT NULL, dropped INT NOT NULL, repos_new INT NOT NULL, repos_changed INT NOT NULL, repos_unchanged INT NOT NULL, windows_completed INT NOT NULL, windows_failed INT NOT NULL, sweep_repos_total INT NOT NULL, sweep_windows_pending INT NOT NULL, stopped_at_limit BOOLEAN NOT NULL, failed_windows JSON NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX idx_discovery_runs_query_slug ON discovery_runs (query_slug)');
        $this->addSql('CREATE INDEX idx_discovery_runs_outcome ON discovery_runs (outcome)');
        $this->addSql('CREATE TABLE discovery_state (query_slug VARCHAR(100) NOT NULL, query VARCHAR(255) NOT NULL, started_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, updated_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, current_run_id VARCHAR(32) DEFAULT NULL, pending_windows JSON NOT NULL, completed_windows JSON NOT NULL, failed_windows JSON NOT NULL, repos_seen INT NOT NULL, pages_fetched INT NOT NULL, dropped INT NOT NULL, PRIMARY KEY (query_slug))');
        $this->addSql('CREATE TABLE messenger_messages (id BIGSERIAL NOT NULL, body TEXT NOT NULL, headers TEXT NOT NULL, queue_name VARCHAR(190) NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, available_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, delivered_at TIMESTAMP(0) WITHOUT TIME ZONE DEFAULT NULL, PRIMARY KEY(id))');
        $this->addSql('CREATE INDEX IDX_75EA56E0FB7336F0 ON messenger_messages (queue_name)');
        $this->addSql('CREATE INDEX IDX_75EA56E0E3BD61CE ON messenger_messages (available_at)');
        $this->addSql('CREATE INDEX IDX_75EA56E016BA31DB ON messenger_messages (delivered_at)');
        $this->addSql("COMMENT ON COLUMN messenger_messages.created_at IS '(DC2Type:datetime_immutable)'");
        $this->addSql("COMMENT ON COLUMN messenger_messages.available_at IS '(DC2Type:datetime_immutable)'");
        $this->addSql("COMMENT ON COLUMN messenger_messages.delivered_at IS '(DC2Type:datetime_immutable)'");
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE discovery_repos');
        $this->addSql('DROP TABLE discovery_runs');
        $this->addSql('DROP TABLE discovery_state');
        $this->addSql('DROP TABLE messenger_messages');
    }
}
