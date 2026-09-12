<?php

declare(strict_types=1);

// Boots the kernel and returns the Doctrine ObjectManager, so phpstan-doctrine can resolve
// query builder / repository return types against the real entity metadata.

use Symfony\Component\Dotenv\Dotenv;

require dirname(__DIR__).'/vendor/autoload.php';

(new Dotenv())->bootEnv(dirname(__DIR__).'/.env');

$kernel = new App\Kernel('dev', true);
$kernel->boot();

return $kernel->getContainer()->get('doctrine')->getManager();
