<?php

declare(strict_types=1);

namespace DoctrineMigrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\Migrations\AbstractMigration;

/**
 * Auto-generated Migration: Please modify to your needs!
 */
final class Version20260912105942 extends AbstractMigration
{
    public function getDescription(): string
    {
        return 'Journal write model: journal_events (append-only, ULID PK) and checkpoints (one row per consumer).';
    }

    public function up(Schema $schema): void
    {
        // this up() migration is auto-generated, please modify it to your needs
        $this->addSql('CREATE TABLE checkpoints (consumer_name VARCHAR(128) NOT NULL, last_event_id UUID DEFAULT NULL, updated_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, PRIMARY KEY (consumer_name))');
        $this->addSql('CREATE TABLE journal_events (id UUID NOT NULL, type VARCHAR(64) NOT NULL, repo VARCHAR(255) DEFAULT NULL, payload JSONB NOT NULL, created_at TIMESTAMP(0) WITHOUT TIME ZONE NOT NULL, PRIMARY KEY (id))');
        $this->addSql('CREATE INDEX idx_journal_events_type ON journal_events (type)');
        $this->addSql('CREATE INDEX idx_journal_events_repo ON journal_events (repo)');
    }

    public function down(Schema $schema): void
    {
        // this down() migration is auto-generated, please modify it to your needs
        $this->addSql('DROP TABLE checkpoints');
        $this->addSql('DROP TABLE journal_events');
    }
}
